import { createHash, randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../middleware/auth'
import { campaignRepository, type CampaignRecord, type EmailSummary, type Tx } from '../repositories/campaign.repository'
import { IDEMPOTENCY_KEY_PATTERN, MAX_SUBJECT_LENGTH, type ScheduleBody } from '../schemas/schedule.schema'
import { AppError } from '../utils/errors'
import { normalizeEmail } from '../utils/email-address'
import { htmlToText, sanitizeEmailHtml } from '../utils/html'
import { jobIdForEmail, sortableId } from '../utils/ids'
import { QueueEnqueueError, type EmailQueuePort } from '../queues/email.queue'

export interface SchedulingLimits {
  /** MAX_RECIPIENTS_PER_BATCH: unique recipients accepted per request. */
  maxRecipientsPerBatch: number
  /** Upper bound for a user-supplied hourlyLimit (MAX_EMAILS_PER_HOUR_PER_SENDER). */
  maxHourlyLimit: number
}

export interface ScheduleResult {
  replayed: boolean
  campaign: {
    id: string
    sender: { id: string; email: string }
    subject: string
    startAt: string
    delaySeconds: number
    hourlyLimit: number | null
    recipientCount: number
    createdAt: string
  }
  recipients: { accepted: number; submitted?: number; duplicatesRemoved?: number }
  emails: { id: string; to: string; scheduledAt: string; status: string; jobId: string | null }[]
  idempotencyKey?: string
}

type Detail = { path: string; message: string }

const PAST_TOLERANCE_MS = 60_000 // clock skew: a time up to 1 min in the past is treated as "now"
const MAX_HORIZON_MS = 366 * 24 * 60 * 60 * 1000
const MAX_TX_ATTEMPTS = 3

export const validationError = (details: Detail[]) =>
  new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details)

interface Prepared {
  from: string
  subject: string
  bodyHtml: string
  bodyText: string
  recipients: { email: string; name: string | null }[]
  submitted: number
  startAt: Date
  delaySeconds: number
  hourlyLimit: number | null
  requestHash: string
}

export class SchedulingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly limits: SchedulingLimits,
    private readonly clock: () => number = Date.now,
    private readonly emailQueue?: EmailQueuePort,
  ) {}

  async schedule(user: AuthUser, body: ScheduleBody, headerKey?: string): Promise<ScheduleResult> {
    const clientKey = this.resolveKey(headerKey, body.idempotencyKey)
    const prepared = this.prepare(body)
    const key = clientKey ?? `auto:${randomUUID()}` // no key supplied: nothing to dedupe against

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.prisma.$transaction((tx) => this.run(tx, user.id, key, prepared), {
          maxWait: 10_000,
          timeout: 30_000,
        })
        // The transaction writes a durable outbox row per email. Queue insertion is best-effort
        // here; startup reconciliation handles any Redis outage without losing persisted work.
        if (this.emailQueue) {
          await this.emailQueue.enqueue(result.emails)
          await this.prisma.queueOutbox.updateMany({
            where: { emailId: { in: result.emails.map((email) => email.id) }, deliveredAt: null },
            data: { deliveredAt: new Date(), lastError: null },
          })
        }
        return clientKey ? { ...result, idempotencyKey: clientKey } : result
      } catch (err) {
        // P2002 = unique violation: a concurrent request with the same idempotency key (or a first-time
        // sender) won the race. Retrying finds the committed campaign and replays it.
        if (err instanceof QueueEnqueueError) throw new AppError(503, 'QUEUE_UNAVAILABLE', err.message, { persisted: true, recoverable: true })
        if ((err as { code?: string }).code === 'P2002' && attempt < MAX_TX_ATTEMPTS) continue
        throw err
      }
    }
  }

  private resolveKey(header?: string, body?: string): string | undefined {
    const h = header?.trim() || undefined
    const b = body?.trim() || undefined
    if (h && b && h !== b) {
      throw validationError([{ path: 'idempotencyKey', message: 'Idempotency-Key header and body field differ' }])
    }
    const key = h ?? b
    if (key !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw validationError([
        { path: 'idempotencyKey', message: 'Idempotency key must be 8-128 characters: letters, digits, . _ : -' },
      ])
    }
    return key
  }

  /** Pure validation + normalization. Collects every problem so the client can fix them in one pass. */
  private prepare(body: ScheduleBody): Prepared {
    const problems: Detail[] = []

    const from = normalizeEmail(body.from)
    if (!from.ok) problems.push({ path: 'from', message: `Invalid sender: ${from.reason}` })

    const subject = body.subject.trim()
    if (!subject) problems.push({ path: 'subject', message: 'Subject cannot be empty' })
    else if (subject.length > MAX_SUBJECT_LENGTH) {
      problems.push({ path: 'subject', message: `Subject cannot exceed ${MAX_SUBJECT_LENGTH} characters` })
    } else if (/[\u0000-\u001f\u007f]/.test(subject)) {
      problems.push({ path: 'subject', message: 'Subject cannot contain line breaks or control characters' })
    }

    const bodyHtml = sanitizeEmailHtml(body.bodyHtml)
    const bodyText = htmlToText(bodyHtml)
    if (!bodyText) problems.push({ path: 'bodyHtml', message: 'Email body cannot be empty' })

    if (body.attachments && body.attachments.length > 0) {
      problems.push({ path: 'attachments', message: 'Attachments are not supported yet' })
    }

    // Recipients: normalize, report every invalid entry, drop duplicates (first occurrence wins, order kept).
    const seen = new Map<string, string | null>()
    let duplicates = 0
    body.to.forEach((entry, i) => {
      const raw = typeof entry === 'string' ? entry : entry.email
      const checked = normalizeEmail(raw)
      if (!checked.ok) {
        problems.push({ path: `to.${i}`, message: `"${String(raw).slice(0, 80)}": ${checked.reason}` })
        return
      }
      if (seen.has(checked.value)) {
        duplicates++
        return
      }
      const name = typeof entry === 'string' ? '' : entry.name?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
      seen.set(checked.value, name || null)
    })
    if (seen.size > this.limits.maxRecipientsPerBatch) {
      problems.push({
        path: 'to',
        message: `Too many recipients: ${seen.size} unique addresses, maximum is ${this.limits.maxRecipientsPerBatch} per request`,
      })
    }

    const now = this.clock()
    let startAt = new Date(now)
    if (body.scheduledAt !== undefined) {
      const parsed = parseInstant(body.scheduledAt)
      if (!parsed) {
        problems.push({
          path: 'scheduledAt',
          message: 'scheduledAt must be an ISO-8601 date-time with a UTC offset, e.g. 2026-11-01T09:00:00Z',
        })
      } else if (parsed.getTime() < now - PAST_TOLERANCE_MS) {
        problems.push({ path: 'scheduledAt', message: 'scheduledAt must not be in the past' })
      } else if (parsed.getTime() > now + MAX_HORIZON_MS) {
        problems.push({ path: 'scheduledAt', message: 'scheduledAt cannot be more than a year ahead' })
      } else {
        startAt = new Date(Math.max(parsed.getTime(), now))
      }
    }

    if (body.hourlyLimit !== undefined && (body.hourlyLimit < 1 || body.hourlyLimit > this.limits.maxHourlyLimit)) {
      problems.push({
        path: 'hourlyLimit',
        message: `Hourly limit must be between 1 and ${this.limits.maxHourlyLimit} (leave empty for the default)`,
      })
    }

    if (problems.length > 0) throw validationError(problems)

    const recipients = [...seen].map(([email, name]) => ({ email, name }))
    const delaySeconds = body.delayBetweenSeconds ?? 0
    const hourlyLimit = body.hourlyLimit ?? null
    // Fingerprint of what the client asked for. scheduledAt is hashed as sent (not the resolved "now"),
    // so a retry of an immediate send still matches.
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          (from as { value: string }).value,
          subject,
          bodyHtml,
          recipients,
          body.scheduledAt ?? null,
          delaySeconds,
          hourlyLimit,
        ]),
      )
      .digest('hex')

    return {
      from: (from as { value: string }).value,
      subject,
      bodyHtml,
      bodyText,
      recipients,
      submitted: body.to.length,
      startAt,
      delaySeconds,
      hourlyLimit,
      requestHash,
    }
  }

  /** One PostgreSQL transaction: sender + campaign + every email row, or nothing. */
  private async run(tx: Tx, ownerId: string, key: string, p: Prepared): Promise<ScheduleResult> {
    const existing = await campaignRepository.findByKey(tx, ownerId, key)
    if (existing) {
      if (existing.requestHash && existing.requestHash !== p.requestHash) {
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'This idempotency key was already used with a different request. Use a new key for a new request.',
        )
      }
      const emails = await campaignRepository.emailsOf(tx, existing.id)
      return toResult(existing, emails, true)
    }

    const sender = await campaignRepository.upsertSender(tx, ownerId, p.from)
    const campaign = await campaignRepository.createCampaign(tx, {
      ownerId,
      senderId: sender.id,
      subject: p.subject,
      startAt: p.startAt,
      delaySeconds: p.delaySeconds,
      hourlyLimit: p.hourlyLimit,
      idempotencyKey: key,
      requestHash: p.requestHash,
      recipientCount: p.recipients.length,
    })

    // Campaign pacing is materialized in the data: recipient i is due at startAt + i * delay.
    const now = this.clock()
    const rows = p.recipients.map((r, i) => {
      const id = sortableId('eml', i, now)
      return {
        id,
        ownerId,
        senderId: sender.id,
        campaignId: campaign.id,
        recipientEmail: r.email,
        recipientName: r.name,
        subject: p.subject,
        bodyHtml: p.bodyHtml,
        bodyText: p.bodyText,
        status: 'scheduled' as const,
        scheduledAt: new Date(p.startAt.getTime() + i * p.delaySeconds * 1000),
        jobId: jobIdForEmail(id), // deterministic; the BullMQ job itself is created in a later checkpoint
        idempotencyKey: `${key}#${r.email}`,
      }
    })
    await campaignRepository.createEmails(tx, rows)
    await campaignRepository.createQueueOutbox(
      tx,
      rows.map((row) => ({ emailId: row.id, jobId: row.jobId! })),
    )

    const emails: EmailSummary[] = rows.map((r) => ({
      id: r.id,
      recipientEmail: r.recipientEmail,
      scheduledAt: r.scheduledAt,
      status: r.status,
      jobId: r.jobId,
    }))
    return toResult(campaign, emails, false, {
      submitted: p.submitted,
      duplicatesRemoved: p.submitted - p.recipients.length,
    })
  }
}

function parseInstant(value: string): Date | null {
  const v = value.trim()
  // Require an explicit offset: a bare local time would silently depend on the server's timezone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i.test(v)) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

function toResult(
  c: CampaignRecord,
  emails: EmailSummary[],
  replayed: boolean,
  counts?: { submitted: number; duplicatesRemoved: number },
): ScheduleResult {
  return {
    replayed,
    campaign: {
      id: c.id,
      sender: c.sender,
      subject: c.subject,
      startAt: c.startAt.toISOString(),
      delaySeconds: c.delaySeconds,
      hourlyLimit: c.hourlyLimit,
      recipientCount: c.recipientCount,
      createdAt: c.createdAt.toISOString(),
    },
    recipients: { accepted: c.recipientCount, ...counts },
    emails: emails.map((e) => ({
      id: e.id,
      to: e.recipientEmail,
      scheduledAt: e.scheduledAt.toISOString(),
      status: e.status,
      jobId: e.jobId,
    })),
  }
}

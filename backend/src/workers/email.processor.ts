import type { Prisma, PrismaClient } from '@prisma/client'
import { DelayedError, UnrecoverableError, type Job } from 'bullmq'
import type { EmailJobData } from '../queues/email.queue'
import type { HourlyLimiter } from '../services/hourly-limiter.service'
import type { SendThrottle } from '../services/send-throttle.service'
import type { HourlyLimitEvent, SlackService } from '../services/slack.service'
import { classifySmtpError, messageIdFor, SmtpDeliveryError, type DeliveryPort } from '../services/smtp.service'
import { logger } from '../utils/logger'

/** The slice of a BullMQ job the processor uses (lets tests pass plain objects). */
export type ProcessableJob = Pick<Job<EmailJobData>, 'id' | 'data' | 'attemptsMade' | 'opts'> & {
  stalledCounter?: number
  moveToDelayed(timestamp: number, token?: string): Promise<void>
}

export interface ProcessorLimits {
  globalPerHour: number
  senderCapPerHour: number
}

export interface ProcessorDeps {
  prisma: PrismaClient
  delivery: DeliveryPort
  hourly: Pick<HourlyLimiter, 'reserve' | 'refund'>
  throttle: Pick<SendThrottle, 'tryAcquire'>
  slack?: Pick<SlackService, 'notifyHourlyLimit'>
  limits: ProcessorLimits
  /** A 'processing' row older than this was abandoned by a crashed worker. */
  staleProcessingMs: number
  now?: () => number
  random?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Upper bound for the random extra delay added to an interval-throttle deferral (spreads wake-ups). */
  throttleJitterMaxMs?: number
}

export type ProcessResult = { skipped: true; reason: string } | { sent: true; messageId: string }

/** Tolerance for a job that fires a hair before scheduledAt (clock skew between API host and worker). */
const DUE_TOLERANCE_MS = 1000
const HOUR_MS = 3_600_000

/**
 * Effective hourly limits for one email. A campaign's requested limit is only ever an additional,
 * lower cap: it is clamped to the sender cap, which is clamped to the global cap, so a campaign (or a
 * sender override) can never raise capacity above the configured maximums - even if those maximums
 * were lowered after the campaign was created.
 */
export function effectiveLimits(
  cfg: ProcessorLimits,
  sender: { hourlyLimitOverride: number | null },
  campaign: { hourlyLimit: number | null } | null,
) {
  const globalLimit = cfg.globalPerHour
  const senderLimit = Math.min(sender.hourlyLimitOverride ?? cfg.senderCapPerHour, cfg.senderCapPerHour, globalLimit)
  const campaignLimit = campaign?.hourlyLimit ? Math.min(campaign.hourlyLimit, senderLimit, globalLimit) : 0
  return { globalLimit, senderLimit, campaignLimit }
}

/**
 * Best-effort recipient ordering when many emails are pushed into the next hour: earlier-scheduled
 * emails get a slightly earlier wake-up (0-3.6 s, one ms per second of original lateness), and BullMQ
 * releases same-time jobs in insertion order. This is a tie-breaker, not a strict guarantee.
 */
export function orderingOffsetMs(scheduledAtMs: number, nowMs: number): number {
  return Math.min(3599, Math.max(0, Math.floor((scheduledAtMs - (nowMs - HOUR_MS)) / 1000)))
}

const cut = (s: string) => s.slice(0, 1000)

/**
 * State machine:  scheduled -> processing -> sent | failed
 *                      ^           |
 *                      +-----------+   (gate denied: deferred; transient SMTP error: retry)
 *
 * Order of operations (each step guarded by an atomic UPDATE ... WHERE status = ...):
 *   1. claim the row            - a duplicate job loses here and never touches Redis or SMTP
 *   2. hourly capacity          - atomic, replay-safe; denied => defer to the next UTC hour
 *   3. global interval slot     - atomic; denied => defer by the exact remaining wait
 *   4. record the SMTP attempt  - attemptCount++ and smtpAttemptedAt (deferrals are NOT attempts)
 *   5. send, then record sent   - only after SMTP accepted
 */
export function createEmailProcessor(deps: ProcessorDeps) {
  const { prisma } = deps
  const clock = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const jitterMax = deps.throttleJitterMaxMs ?? 100

  async function defer(job: ProcessableJob, token: string | undefined, timestamp: number): Promise<never> {
    // moveToDelayed does not count as a failed attempt, so BullMQ's retry budget is untouched.
    await job.moveToDelayed(timestamp, token)
    throw new DelayedError()
  }

  async function recordSent(emailId: string, messageId: string, previewUrl: string | null): Promise<void> {
    let lastError: unknown
    for (let i = 0; i < 3; i++) {
      try {
        const r = await prisma.email.updateMany({
          where: { id: emailId, status: 'processing' },
          data: { status: 'sent', sentAt: new Date(clock()), smtpMessageId: messageId, previewUrl, failureReason: null, processingStartedAt: null },
        })
        if (r.count !== 1) logger.error({ emailId, messageId }, 'SMTP accepted the message but the row was no longer in processing')
        return
      } catch (err) {
        lastError = err
        await sleep(50 * 2 ** i)
      }
    }
    // The message WAS accepted by SMTP. Do NOT mark it failed or retry it. The row stays 'processing'
    // with smtpAttemptedAt set; stale recovery will flag it UNCERTAIN (never silently resend).
    logger.error({ emailId, messageId, err: lastError }, 'SMTP accepted the message but recording "sent" failed')
    throw new UnrecoverableError(`Email was accepted by SMTP (${messageId}) but the result could not be recorded: ${(lastError as Error)?.message ?? 'database error'}`)
  }

  return async (job: ProcessableJob, token?: string): Promise<ProcessResult> => {
    const emailId = job.data?.emailId
    if (!emailId || typeof emailId !== 'string') throw new UnrecoverableError('Invalid email job: missing emailId')

    const email = await prisma.email.findUnique({
      where: { id: emailId },
      include: {
        sender: { select: { id: true, email: true, displayName: true, hourlyLimitOverride: true } },
        campaign: { select: { id: true, hourlyLimit: true } },
      },
    })
    if (!email) {
      logger.warn({ jobId: job.id, emailId }, 'email job references a missing email; skipping')
      return { skipped: true, reason: 'missing' }
    }

    if (email.status === 'sent' || email.status === 'failed' || email.status === 'cancelled') {
      // Cancelled before any SMTP attempt: give back any capacity it had reserved.
      if (email.status === 'cancelled') await deps.hourly.refund(emailId).catch(() => undefined)
      logger.info({ jobId: job.id, emailId, status: email.status }, 'email job no longer actionable; skipping')
      return { skipped: true, reason: email.status }
    }

    const now = clock()

    // ---- 1. claim ------------------------------------------------------------------------------
    if (email.status === 'processing') {
      const lastStart = email.processingStartedAt?.getTime() ?? 0
      const abandoned = (job.stalledCounter ?? 0) > 0 || now - lastStart > deps.staleProcessingMs
      if (!abandoned) {
        logger.info({ jobId: job.id, emailId }, 'email is being processed by another worker; skipping duplicate job')
        return { skipped: true, reason: 'in-progress' }
      }
      if (email.smtpAttemptedAt) {
        // The previous worker got as far as the SMTP call. Whether the server accepted the message is unknowable.
        const reason = cut(`UNCERTAIN: a worker was lost during the SMTP attempt; the message may have been delivered (Message-ID ${messageIdFor(emailId)}). Not resent automatically to avoid a duplicate.`)
        await prisma.email.updateMany({
          where: { id: emailId, status: 'processing', processingStartedAt: email.processingStartedAt },
          data: { status: 'failed', failureReason: reason, processingStartedAt: null },
        })
        throw new UnrecoverableError(reason)
      }
      // The previous worker never reached SMTP, so re-claiming and sending is safe. Optimistic guard so
      // two workers cannot both reclaim the same stale row.
      const reclaimed = await prisma.email.updateMany({
        where: { id: emailId, status: 'processing', processingStartedAt: email.processingStartedAt },
        data: { processingStartedAt: new Date(now) },
      })
      if (reclaimed.count !== 1) return { skipped: true, reason: 'claimed-elsewhere' }
      logger.warn({ jobId: job.id, emailId }, 'reclaimed an abandoned processing email that never reached SMTP')
    } else {
      // status === 'scheduled'. Not yet due (job fired early, or deferral wrote a later scheduledAt)?
      if (email.scheduledAt.getTime() > now + DUE_TOLERANCE_MS) return defer(job, token, email.scheduledAt.getTime())
      const claimed = await prisma.email.updateMany({
        where: { id: emailId, status: 'scheduled' },
        data: { status: 'processing', processingStartedAt: new Date(now) },
      })
      if (claimed.count !== 1) {
        const current = await prisma.email.findUnique({ where: { id: emailId }, select: { status: true } })
        if (current?.status === 'cancelled') await deps.hourly.refund(emailId).catch(() => undefined)
        logger.info({ jobId: job.id, emailId, status: current?.status }, 'email was claimed or changed concurrently; skipping')
        return { skipped: true, reason: 'claimed-elsewhere' }
      }
    }

    const releaseClaim = (extra: Prisma.EmailUpdateManyMutationInput = {}) =>
      prisma.email.updateMany({ where: { id: emailId, status: 'processing' }, data: { status: 'scheduled', processingStartedAt: null, ...extra } })

    // ---- 2. hourly capacity ---------------------------------------------------------------------
    const lim = effectiveLimits(deps.limits, email.sender, email.campaign)
    let reservation
    try {
      reservation = await deps.hourly.reserve({
        emailId,
        senderId: email.senderId,
        campaignId: email.campaign?.id ?? null,
        globalLimit: lim.globalLimit,
        senderLimit: lim.senderLimit,
        campaignLimit: lim.campaignLimit,
      })
    } catch (err) {
      await releaseClaim()
      throw err
    }
    if (!reservation.granted) {
      const target = reservation.nextWindowAt + orderingOffsetMs(email.scheduledAt.getTime(), now)
      // PostgreSQL first (authoritative), then BullMQ. A crash in between is healed by the stalled-job path:
      // the redelivered job sees scheduledAt in the future and delays itself again.
      const updated = await releaseClaim({ scheduledAt: new Date(target), failureReason: null })
      if (updated.count !== 1) {
        await deps.hourly.refund(emailId).catch(() => undefined)
        return { skipped: true, reason: 'changed-during-deferral' }
      }
      if (deps.slack && reservation.scope === 'sender') {
        const event: HourlyLimitEvent = {
          ownerId: email.ownerId,
          senderId: email.senderId,
          senderEmail: email.sender.email,
          scope: reservation.scope,
          window: reservation.window,
        }
        try {
          const result = await deps.slack.notifyHourlyLimit(event)
          if (result === 'sent') logger.info({ emailId, senderId: email.senderId, scope: reservation.scope }, 'Slack hourly-limit notification sent')
        } catch (err) {
          logger.warn({ emailId, senderId: email.senderId, err }, 'Slack hourly-limit notification failed; email remains safely deferred')
        }
      }
      logger.info({ emailId, scope: reservation.scope, deferredTo: new Date(target).toISOString() }, 'hourly limit reached; email deferred to the next window')
      return defer(job, token, target)
    }

    // ---- 3. global send interval ----------------------------------------------------------------
    let slot
    try {
      slot = await deps.throttle.tryAcquire()
    } catch (err) {
      await releaseClaim()
      throw err
    }
    if (!slot.granted) {
      // Keep the hourly reservation: replay-safe, and the job returns within seconds.
      await releaseClaim()
      const target = now + slot.waitMs + Math.floor(random() * jitterMax)
      return defer(job, token, target)
    }

    // ---- 4. record the SMTP attempt ------------------------------------------------------------
    const started = await prisma.email.updateMany({
      where: { id: emailId, status: 'processing' },
      data: { attemptCount: { increment: 1 }, smtpAttemptedAt: new Date(clock()), smtpMessageId: messageIdFor(emailId) },
    })
    if (started.count !== 1) return { skipped: true, reason: 'changed-before-send' }

    // ---- 5. send -------------------------------------------------------------------------------
    let receipt
    try {
      receipt = await deps.delivery.send({
        emailId,
        from: { address: email.sender.email, name: email.sender.displayName },
        to: email.recipientEmail,
        subject: email.subject,
        html: email.bodyHtml,
        text: email.bodyText,
      })
    } catch (err) {
      const failure = err instanceof SmtpDeliveryError ? err : classifySmtpError(err)
      const attempts = job.opts.attempts ?? 1
      const finalAttempt = job.attemptsMade + 1 >= attempts

      if (failure.kind === 'uncertain') {
        const reason = cut(`UNCERTAIN: ${failure.message}. The server may have accepted the message (Message-ID ${messageIdFor(emailId)}); not retried automatically to avoid a duplicate send.`)
        await prisma.email.updateMany({ where: { id: emailId, status: 'processing' }, data: { status: 'failed', failureReason: reason, processingStartedAt: null } })
        throw new UnrecoverableError(reason)
      }
      if (failure.kind === 'permanent') {
        const reason = cut(`Permanent SMTP failure: ${failure.message}`)
        await prisma.email.updateMany({ where: { id: emailId, status: 'processing' }, data: { status: 'failed', failureReason: reason, processingStartedAt: null } })
        throw new UnrecoverableError(reason)
      }
      // transient: the server provably did not accept it.
      if (finalAttempt) {
        const reason = cut(`Delivery failed after ${attempts} attempts: ${failure.message}`)
        await prisma.email.updateMany({ where: { id: emailId, status: 'processing' }, data: { status: 'failed', failureReason: reason, processingStartedAt: null } })
        throw failure
      }
      await releaseClaim({ failureReason: cut(`Temporary SMTP failure (will retry): ${failure.message}`), smtpAttemptedAt: null })
      throw failure // BullMQ re-queues it with exponential backoff
    }

    await recordSent(emailId, receipt.messageId, receipt.previewUrl)
    return { sent: true, messageId: receipt.messageId }
  }
}

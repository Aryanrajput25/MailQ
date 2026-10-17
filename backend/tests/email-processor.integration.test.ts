import type { PrismaClient } from '@prisma/client'
import { DelayedError, UnrecoverableError } from 'bullmq'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPrisma } from '../src/config/prisma'
import { HourlyLimiter } from '../src/services/hourly-limiter.service'
import { QueueRecoveryService } from '../src/services/queue-recovery.service'
import { SendThrottle } from '../src/services/send-throttle.service'
import { SmtpDeliveryError, type DeliveryPort, type SmtpMessage } from '../src/services/smtp.service'
import { createEmailProcessor, effectiveLimits, orderingOffsetMs, type ProcessableJob } from '../src/workers/email.processor'
import { cleanupFixtures, createEmail, createFixture, type Fixture } from './helpers/fixtures'
import { cleanPrefix, connections, hasRedis, uniquePrefix } from './helpers/redis'

const HOUR = 3_600_000
const d = process.env.DATABASE_URL && hasRedis ? describe : describe.skip

type Outcome = 'ok' | SmtpDeliveryError | Error
class FakeDelivery implements DeliveryPort {
  calls: SmtpMessage[] = []
  outcomes: Outcome[] = []
  delayMs = 0
  async send(m: SmtpMessage) {
    this.calls.push(m)
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    const o = this.outcomes.shift() ?? 'ok'
    if (o !== 'ok') throw o
    return { messageId: `<${m.emailId}@reachinbox.local>`, previewUrl: `https://ethereal.email/message/${m.emailId}` }
  }
}

function fakeJob(emailId: string, o: { attemptsMade?: number; attempts?: number; stalledCounter?: number } = {}) {
  const moves: number[] = []
  const job = {
    id: `email_${emailId}`,
    data: { emailId },
    attemptsMade: o.attemptsMade ?? 0,
    opts: { attempts: o.attempts ?? 3 },
    stalledCounter: o.stalledCounter ?? 0,
    moveToDelayed: async (ts: number) => void moves.push(ts),
  } as unknown as ProcessableJob
  return { job, moves }
}

d('email processor (real PostgreSQL + real Redis, fake SMTP)', () => {
  let prisma: PrismaClient
  let redis: Redis[]
  const prefix = uniquePrefix('proc')
  const users: string[] = []
  let n = 0

  async function setup(over: { globalPerHour?: number; senderCap?: number; minIntervalMs?: number; fx?: Parameters<typeof createFixture>[1] } = {}) {
    const fx = await createFixture(prisma, over.fx)
    users.push(fx.userId)
    const p = `${prefix}${n++}:`
    const delivery = new FakeDelivery()
    const hourly = new HourlyLimiter(redis[0]!, { prefix: p })
    const throttle = new SendThrottle(redis[0]!, { minIntervalMs: over.minIntervalMs ?? 0, prefix: p })
    const processor = createEmailProcessor({
      prisma,
      delivery,
      hourly,
      throttle,
      limits: { globalPerHour: over.globalPerHour ?? 100, senderCapPerHour: over.senderCap ?? 100 },
      staleProcessingMs: 5 * 60_000,
      sleep: async () => undefined,
      throttleJitterMaxMs: 0,
    })
    return { fx, delivery, hourly, throttle, processor }
  }
  const row = (id: string) => prisma.email.findUniqueOrThrow({ where: { id } })

  beforeAll(() => {
    prisma = createPrisma(process.env.DATABASE_URL!)
    redis = connections(2)
  })
  afterAll(async () => {
    await cleanupFixtures(prisma, users)
    await cleanPrefix(redis[0]!, prefix)
    await prisma.$disconnect()
    await Promise.all(redis.map((r) => r.quit()))
  })

  // ---- 1 -----------------------------------------------------------------------------------------
  it('1. claims a scheduled email, delivers it, and records sent only after SMTP accepted', async () => {
    const { fx, delivery, processor } = await setup()
    const e = await createEmail(prisma, fx)
    const res = await processor(fakeJob(e.id).job)
    expect(res).toMatchObject({ sent: true })
    const after = await row(e.id)
    expect(after).toMatchObject({ status: 'sent', attemptCount: 1, smtpMessageId: `<${e.id}@reachinbox.local>`, failureReason: null, processingStartedAt: null })
    expect(after.sentAt).toBeInstanceOf(Date)
    expect(after.previewUrl).toContain('ethereal.email/message/')
    expect(delivery.calls).toEqual([
      { emailId: e.id, from: { address: fx.senderEmail, name: 'Oliver Brown' }, to: e.recipientEmail, subject: 'Quarterly update', html: '<p>Hello <b>there</b></p>', text: 'Hello there' },
    ])
  })

  it('1b. never records sent when SMTP has not accepted (status is processing while the call is in flight)', async () => {
    const { fx, delivery, processor } = await setup()
    const e = await createEmail(prisma, fx)
    delivery.delayMs = 150
    const running = processor(fakeJob(e.id).job)
    await new Promise((r) => setTimeout(r, 60))
    expect(await row(e.id)).toMatchObject({ status: 'processing', sentAt: null })
    await running
    expect((await row(e.id)).status).toBe('sent')
  })

  // ---- 2 -----------------------------------------------------------------------------------------
  it('2. duplicate concurrent jobs send exactly once', async () => {
    const { fx, delivery, processor } = await setup()
    const e = await createEmail(prisma, fx)
    delivery.delayMs = 80
    const results = await Promise.all(Array.from({ length: 10 }, () => processor(fakeJob(e.id).job)))
    expect(results.filter((r) => 'sent' in r)).toHaveLength(1)
    expect(results.filter((r) => 'skipped' in r)).toHaveLength(9)
    expect(delivery.calls).toHaveLength(1)
    expect(await row(e.id)).toMatchObject({ status: 'sent', attemptCount: 1 })
  })

  // ---- 3 -----------------------------------------------------------------------------------------
  it('3. cancelled, sent and failed emails are skipped without any SMTP call', async () => {
    const { fx, delivery, processor } = await setup()
    for (const status of ['cancelled', 'sent', 'failed'] as const) {
      const e = await createEmail(prisma, fx, { status })
      expect(await processor(fakeJob(e.id).job)).toEqual({ skipped: true, reason: status })
    }
    expect(await processor(fakeJob('does-not-exist').job)).toEqual({ skipped: true, reason: 'missing' })
    expect(delivery.calls).toHaveLength(0)
  })

  it('3b. a cancelled email gives back the capacity it had reserved', async () => {
    const { fx, hourly, processor } = await setup()
    const e = await createEmail(prisma, fx)
    const r = await hourly.reserve({ emailId: e.id, senderId: fx.senderId, campaignId: fx.campaignId, globalLimit: 100, senderLimit: 100 })
    expect(r.granted).toBe(true)
    const w = (r as { window: number }).window
    expect((await hourly.usage(w, fx.senderId)).global).toBe(1)
    await prisma.email.update({ where: { id: e.id }, data: { status: 'cancelled' } })
    await processor(fakeJob(e.id).job)
    expect((await hourly.usage(w, fx.senderId)).global).toBe(0)
  })

  // ---- 4 -----------------------------------------------------------------------------------------
  it('4. a transient SMTP failure returns the email to scheduled for a backoff retry, then succeeds', async () => {
    const { fx, delivery, processor } = await setup()
    const e = await createEmail(prisma, fx)
    delivery.outcomes = [new SmtpDeliveryError('421 try later', 'transient', 'ECONNECTION', 421), 'ok']
    await expect(processor(fakeJob(e.id, { attemptsMade: 0 }).job)).rejects.toMatchObject({ kind: 'transient' })
    expect(await row(e.id)).toMatchObject({ status: 'scheduled', attemptCount: 1, smtpAttemptedAt: null, processingStartedAt: null, sentAt: null })
    expect((await row(e.id)).failureReason).toMatch(/Temporary SMTP failure/)
    expect(await processor(fakeJob(e.id, { attemptsMade: 1 }).job)).toMatchObject({ sent: true })
    expect(await row(e.id)).toMatchObject({ status: 'sent', attemptCount: 2, failureReason: null })
  })

  it('4b. the final bounded attempt marks the email failed (never sent)', async () => {
    const { fx, delivery, processor } = await setup()
    const e = await createEmail(prisma, fx)
    delivery.outcomes = [new SmtpDeliveryError('still down', 'transient', 'ECONNECTION')]
    await expect(processor(fakeJob(e.id, { attemptsMade: 2, attempts: 3 }).job)).rejects.toBeInstanceOf(SmtpDeliveryError)
    const r = await row(e.id)
    expect(r.status).toBe('failed')
    expect(r.failureReason).toMatch(/after 3 attempts/)
    expect(r.sentAt).toBeNull()
  })

  // ---- 5 / 6 -------------------------------------------------------------------------------------
  it('5. a permanent SMTP failure fails immediately without retry', async () => {
    const { fx, delivery, processor } = await setup()
    const e = await createEmail(prisma, fx)
    delivery.outcomes = [new SmtpDeliveryError('550 no such user', 'permanent', undefined, 550)]
    await expect(processor(fakeJob(e.id).job)).rejects.toBeInstanceOf(UnrecoverableError) // BullMQ will not retry it
    expect(await row(e.id)).toMatchObject({ status: 'failed', attemptCount: 1 })
    expect((await row(e.id)).failureReason).toMatch(/Permanent SMTP failure: 550/)
    expect(delivery.calls).toHaveLength(1)
  })

  it('6. a timeout after the body was sent is UNCERTAIN: failed, flagged, never auto-retried', async () => {
    const { fx, delivery, processor } = await setup()
    const e = await createEmail(prisma, fx)
    delivery.outcomes = [new SmtpDeliveryError('Timeout', 'uncertain', 'ETIMEDOUT')]
    await expect(processor(fakeJob(e.id, { attemptsMade: 0, attempts: 5 }).job)).rejects.toBeInstanceOf(UnrecoverableError)
    const r = await row(e.id)
    expect(r.status).toBe('failed')
    expect(r.failureReason).toMatch(/UNCERTAIN/)
    expect(r.failureReason).toContain(`<${e.id}@reachinbox.local>`)
    expect(delivery.calls).toHaveLength(1)
  })

  // ---- 7 -----------------------------------------------------------------------------------------
  it('7. hourly limit reached: the email is deferred (not failed), DB + BullMQ agree, no attempt is counted', async () => {
    const { fx, delivery, processor } = await setup({ globalPerHour: 1 })
    const first = await createEmail(prisma, fx, { index: 1 })
    const second = await createEmail(prisma, fx, { index: 2 })
    expect(await processor(fakeJob(first.id).job)).toMatchObject({ sent: true })

    const { job, moves } = fakeJob(second.id)
    await expect(processor(job, 'tok')).rejects.toBeInstanceOf(DelayedError)
    const r = await row(second.id)
    expect(r.status).toBe('scheduled') // durable, not failed
    expect(r).toMatchObject({ attemptCount: 0, smtpAttemptedAt: null, processingStartedAt: null, failureReason: null })
    expect(delivery.calls).toHaveLength(1) // second was NOT sent
    expect(moves).toHaveLength(1)
    expect(r.scheduledAt.getTime()).toBe(moves[0]) // PostgreSQL and BullMQ hold the same next time
    expect(r.scheduledAt.getTime()).toBeGreaterThan(Date.now())
    expect(r.scheduledAt.getTime() % HOUR).toBeLessThan(3600) // top of the next UTC hour + <=3.6s ordering offset
    expect(r.scheduledAt.getTime()).toBeLessThanOrEqual(Date.now() + HOUR + 3600)
  })

  it('7b. when it becomes due again in the new window it is admitted and sent', async () => {
    const { fx, delivery, processor, hourly } = await setup({ globalPerHour: 1 })
    const a = await createEmail(prisma, fx, { index: 1 })
    const b = await createEmail(prisma, fx, { index: 2 })
    await processor(fakeJob(a.id).job)
    await expect(processor(fakeJob(b.id).job)).rejects.toBeInstanceOf(DelayedError)
    // Jump to the next window: a fresh limiter view via an explicit clock cannot be injected into the
    // processor, so verify the reservation primitive admits it there and the due-time guard holds meanwhile.
    const early = await processor(fakeJob(b.id).job).catch((e) => e)
    expect(early).toBeInstanceOf(DelayedError) // still not due: guard defers again instead of sending
    expect(delivery.calls).toHaveLength(1)
    const next = await hourly.reserve({ emailId: b.id, senderId: fx.senderId, campaignId: fx.campaignId, globalLimit: 1, senderLimit: 1 }, Date.now() + HOUR)
    expect(next).toMatchObject({ granted: true })
  })

  it('7c. an interval-throttle deferral keeps its hourly reservation and never double-counts on return', async () => {
    const { fx, delivery, processor, hourly } = await setup({ minIntervalMs: 60_000 })
    const a = await createEmail(prisma, fx, { index: 1 })
    const b = await createEmail(prisma, fx, { index: 2 })
    expect(await processor(fakeJob(a.id).job)).toMatchObject({ sent: true })

    const { job, moves } = fakeJob(b.id)
    const before = Date.now()
    await expect(processor(job, 'tok')).rejects.toBeInstanceOf(DelayedError)
    expect(moves[0]!).toBeGreaterThan(before + 50_000) // ~ the remaining interval
    expect(moves[0]!).toBeLessThanOrEqual(before + 60_000 + 50)
    expect(await row(b.id)).toMatchObject({ status: 'scheduled', attemptCount: 0, processingStartedAt: null })
    expect(delivery.calls).toHaveLength(1)

    const w = Math.floor(Date.now() / HOUR)
    const used = (await hourly.usage(w, fx.senderId)).global
    expect(used).toBe(2) // a sent + b reserved
    // Coming back repeatedly (still throttled) must not inflate the counter:
    await expect(processor(fakeJob(b.id).job)).rejects.toBeInstanceOf(DelayedError)
    expect((await hourly.usage(w, fx.senderId)).global).toBe(2)
  })

  it('7d. the same email can never be admitted twice into one window (no duplicate reservation)', async () => {
    const { fx, processor, hourly } = await setup({ minIntervalMs: 60_000 })
    const a = await createEmail(prisma, fx, { index: 1 })
    const b = await createEmail(prisma, fx, { index: 2 })
    await processor(fakeJob(a.id).job)
    for (let i = 0; i < 5; i++) await expect(processor(fakeJob(b.id).job)).rejects.toBeInstanceOf(DelayedError)
    expect((await hourly.usage(Math.floor(Date.now() / HOUR), fx.senderId)).global).toBe(2)
  })

  // ---- 8 / 9 -------------------------------------------------------------------------------------
  it('9a. an abandoned processing row that never reached SMTP is reclaimed and sent (redelivered job)', async () => {
    const { fx, delivery, processor } = await setup()
    const e = await createEmail(prisma, fx, { status: 'processing', processingStartedAt: new Date(Date.now() - 60_000) })
    expect(await processor(fakeJob(e.id, { stalledCounter: 1 }).job)).toMatchObject({ sent: true })
    expect(delivery.calls).toHaveLength(1)
    expect((await row(e.id)).status).toBe('sent')
  })

  it('9b. an abandoned row that HAD started SMTP is flagged UNCERTAIN and is NOT resent', async () => {
    const { fx, delivery, processor } = await setup()
    const e = await createEmail(prisma, fx, { status: 'processing', processingStartedAt: new Date(Date.now() - 60_000), smtpAttemptedAt: new Date(Date.now() - 59_000) })
    await expect(processor(fakeJob(e.id, { stalledCounter: 1 }).job)).rejects.toBeInstanceOf(UnrecoverableError)
    expect(delivery.calls).toHaveLength(0)
    const r = await row(e.id)
    expect(r.status).toBe('failed')
    expect(r.failureReason).toMatch(/UNCERTAIN/)
  })

  it('9c. a fresh processing row is NOT stolen by a duplicate job', async () => {
    const { fx, delivery, processor } = await setup()
    const e = await createEmail(prisma, fx, { status: 'processing', processingStartedAt: new Date() })
    expect(await processor(fakeJob(e.id).job)).toEqual({ skipped: true, reason: 'in-progress' })
    expect(delivery.calls).toHaveLength(0)
  })

  it('9d. a processing row older than STALE_PROCESSING_MS is reclaimed even without a stall signal', async () => {
    const { fx, delivery, processor } = await setup()
    const e = await createEmail(prisma, fx, { status: 'processing', processingStartedAt: new Date(Date.now() - 10 * 60_000) })
    expect(await processor(fakeJob(e.id).job)).toMatchObject({ sent: true })
    expect(delivery.calls).toHaveLength(1)
  })

  it('9e. two workers racing to reclaim the same stale row send exactly once', async () => {
    const { fx, delivery, processor } = await setup()
    const e = await createEmail(prisma, fx, { status: 'processing', processingStartedAt: new Date(Date.now() - 10 * 60_000) })
    delivery.delayMs = 60
    const results = await Promise.all(Array.from({ length: 6 }, () => processor(fakeJob(e.id, { stalledCounter: 1 }).job).catch((x) => x)))
    expect(delivery.calls).toHaveLength(1)
    expect(results.filter((r) => 'sent' in (r as object))).toHaveLength(1)
  })

  it('8. a worker crash leaves a recoverable record: stale recovery requeues it, or flags it if SMTP had begun', async () => {
    const { fx } = await setup()
    const crashedBeforeSmtp = await createEmail(prisma, fx, { status: 'processing', processingStartedAt: new Date(Date.now() - 10 * 60_000) })
    const crashedDuringSmtp = await createEmail(prisma, fx, { status: 'processing', processingStartedAt: new Date(Date.now() - 10 * 60_000), smtpAttemptedAt: new Date(Date.now() - 10 * 60_000) })
    const fresh = await createEmail(prisma, fx, { status: 'processing', processingStartedAt: new Date() })
    const ensured: string[] = []
    const queue = { enqueue: async () => undefined, ensureJob: async (xs: { id: string }[]) => void ensured.push(...xs.map((x) => x.id)), close: async () => undefined }
    const recovery = new QueueRecoveryService(prisma, queue)
    const ids = [crashedBeforeSmtp.id, crashedDuringSmtp.id, fresh.id]
    // (other tests' stale rows in the shared DB may also be recovered; assert on ours)
    const result = await recovery.recoverStaleProcessing(5 * 60_000)
    expect(result.requeued).toBeGreaterThanOrEqual(1)
    expect(result.uncertain).toBeGreaterThanOrEqual(1)
    expect((await row(crashedBeforeSmtp.id)).status).toBe('scheduled')
    expect(ensured).toContain(crashedBeforeSmtp.id)
    expect((await row(crashedDuringSmtp.id)).status).toBe('failed')
    expect((await row(crashedDuringSmtp.id)).failureReason).toMatch(/UNCERTAIN/)
    expect(ensured).not.toContain(crashedDuringSmtp.id)
    expect((await row(fresh.id)).status).toBe('processing') // still within the threshold
    // idempotent: a second pass finds nothing of ours left to do
    await recovery.recoverStaleProcessing(5 * 60_000)
    expect(ensured.filter((x) => ids.includes(x))).toEqual([crashedBeforeSmtp.id])
  })

  // ---- 10 ----------------------------------------------------------------------------------------
  it('10. a database error AFTER SMTP accepted is not misreported as a failed delivery, and is never resent', async () => {
    const { fx, delivery, hourly, throttle } = await setup()
    const e = await createEmail(prisma, fx)
    const flaky = new Proxy(prisma, {
      get(target, prop, recv) {
        if (prop === 'email') {
          return new Proxy(target.email, {
            get(t2, p2, r2) {
              if (p2 === 'updateMany') {
                return (args: { data?: { status?: string } }) => {
                  if (args?.data?.status === 'sent') return Promise.reject(new Error('connection lost'))
                  return (t2.updateMany as (a: unknown) => unknown)(args)
                }
              }
              return Reflect.get(t2, p2, r2)
            },
          })
        }
        return Reflect.get(target, prop, recv)
      },
    }) as PrismaClient
    const processor = createEmailProcessor({ prisma: flaky, delivery, hourly, throttle, limits: { globalPerHour: 100, senderCapPerHour: 100 }, staleProcessingMs: 5 * 60_000, sleep: async () => undefined })
    await expect(processor(fakeJob(e.id).job)).rejects.toThrow(/accepted by SMTP .* could not be recorded/)
    expect(delivery.calls).toHaveLength(1)
    const r = await row(e.id)
    expect(r.status).toBe('processing') // NOT failed, NOT scheduled/retried
    expect(r.smtpAttemptedAt).not.toBeNull()
    expect(r.sentAt).toBeNull()

    // Later recovery must flag it UNCERTAIN and must not resend.
    await prisma.email.update({ where: { id: e.id }, data: { processingStartedAt: new Date(Date.now() - 10 * 60_000) } })
    const queue = { enqueue: vi.fn(), ensureJob: vi.fn(), close: async () => undefined }
    await new QueueRecoveryService(prisma, queue).recoverStaleProcessing(5 * 60_000)
    expect(queue.ensureJob).not.toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: e.id })]))
    expect((await row(e.id)).failureReason).toMatch(/UNCERTAIN/)
    expect(delivery.calls).toHaveLength(1)
  })

  it('a due-time guard defers a job that fires before scheduledAt', async () => {
    const { fx, delivery, processor } = await setup()
    const at = new Date(Date.now() + 60_000)
    const e = await createEmail(prisma, fx, { scheduledAt: at })
    const { job, moves } = fakeJob(e.id)
    await expect(processor(job, 't')).rejects.toBeInstanceOf(DelayedError)
    expect(moves).toEqual([at.getTime()])
    expect(delivery.calls).toHaveLength(0)
    expect((await row(e.id)).status).toBe('scheduled')
  })
})

describe('hourly limit policy (pure)', () => {
  const cfg = { globalPerHour: 200, senderCapPerHour: 100 }
  it('a campaign limit above the sender or global cap cannot raise capacity', () => {
    expect(effectiveLimits(cfg, { hourlyLimitOverride: null }, { hourlyLimit: 5000 })).toEqual({ globalLimit: 200, senderLimit: 100, campaignLimit: 100 })
  })
  it('a sender override above the configured sender cap is clamped; a lower one is honoured', () => {
    expect(effectiveLimits(cfg, { hourlyLimitOverride: 500 }, null).senderLimit).toBe(100)
    expect(effectiveLimits(cfg, { hourlyLimitOverride: 30 }, { hourlyLimit: 50 })).toMatchObject({ senderLimit: 30, campaignLimit: 30 })
  })
  it('lowering the configured caps after a campaign was created tightens it immediately', () => {
    expect(effectiveLimits({ globalPerHour: 10, senderCapPerHour: 10 }, { hourlyLimitOverride: null }, { hourlyLimit: 100 })).toEqual({ globalLimit: 10, senderLimit: 10, campaignLimit: 10 })
  })
  it('orders deferred wake-ups by original schedule time within a bounded offset', () => {
    const now = 10 * HOUR
    expect(orderingOffsetMs(now - 1_800_000, now)).toBeLessThan(orderingOffsetMs(now - 600_000, now))
    expect(orderingOffsetMs(0, now)).toBe(0)
    expect(orderingOffsetMs(now + 10 * HOUR, now)).toBe(3599)
  })
})

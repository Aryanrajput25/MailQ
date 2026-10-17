import type { PrismaClient } from '@prisma/client'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPrisma } from '../src/config/prisma'
import { QueueRecoveryService } from '../src/services/queue-recovery.service'
import { cleanupFixtures, createEmail, createFixture, tag } from './helpers/fixtures'
import { hasRedis } from './helpers/redis'
import { startSmtpServer } from './helpers/smtp-server'
import { createStack, sleep, waitFor } from './helpers/stack'

const HOUR = 3_600_000
const d = process.env.DATABASE_URL && hasRedis ? describe : describe.skip

d('end-to-end delivery (real BullMQ + Redis + PostgreSQL + SMTP protocol server)', () => {
  let prisma: PrismaClient
  const users: string[] = []
  const apiEmails: string[] = []

  beforeAll(() => {
    prisma = createPrisma(process.env.DATABASE_URL!)
  })
  afterAll(async () => {
    await cleanupFixtures(prisma, users)
    await prisma.user.deleteMany({ where: { email: { in: apiEmails } } })
    await prisma.$disconnect()
  })

  async function env(opts: { attempts?: number; backoffMs?: number; smtpTimeoutMs?: number; acceptDelayMs?: number } = {}) {
    const smtp = await startSmtpServer({ acceptDelayMs: opts.acceptDelayMs })
    const stack = createStack({ prisma, smtpCredentials: smtp.credentials, ...opts })
    return {
      smtp,
      stack,
      done: async () => {
        await stack.close()
        await smtp.close()
      },
    }
  }
  const dbEmail = (id: string) => prisma.email.findUniqueOrThrow({ where: { id } })
  const queueEmail = (e: { id: string; jobId: string | null; scheduledAt: Date }) => ({ id: e.id, jobId: e.jobId, scheduledAt: e.scheduledAt.toISOString() })

  it('schedules through the real API, a worker delivers it, and the SMTP server receives the exact message', async () => {
    const { smtp, stack, done } = await env()
    const email = `api-${tag()}@example.com`
    apiEmails.push(email)
    stack.startWorker()
    const res = await request(stack.app())
      .post('/api/emails/schedule')
      .set('x-test-user-email', email)
      .set('Origin', 'http://localhost:3000')
      .send({ from: `oliver.${tag()}@domain.io`, to: ['one@example.com', 'two@example.com'], subject: 'Launch', bodyHtml: '<p>Hello <b>team</b></p>' })
    expect(res.status).toBe(201)
    const ids: string[] = res.body.emails.map((e: { id: string }) => e.id)
    await waitFor(async () => (await prisma.email.count({ where: { id: { in: ids }, status: 'sent' } })) === 2)
    expect(smtp.received.map((r) => r.to[0]).sort()).toEqual(['one@example.com', 'two@example.com'])
    const got = smtp.received[0]!
    expect(got.mail.subject).toBe('Launch')
    expect(got.mail.html).toContain('<b>team</b>')
    expect(got.mail.text).toContain('Hello')
    for (const id of ids) expect(await dbEmail(id)).toMatchObject({ status: 'sent', attemptCount: 1 })
    await done()
  })

  it('global minimum interval holds across TWO workers (6 competing consumers), no email lost or duplicated', async () => {
    const { smtp, stack, done } = await env()
    const fx = await createFixture(prisma)
    users.push(fx.userId)
    const rows = await Promise.all(Array.from({ length: 8 }, (_, i) => createEmail(prisma, fx, { index: i })))
    await stack.queue.enqueue(rows.map(queueEmail))
    stack.startWorker({ concurrency: 3, minDelayMs: 250 })
    stack.startWorker({ concurrency: 3, minDelayMs: 250 })
    await waitFor(async () => (await prisma.email.count({ where: { campaignId: fx.campaignId, status: 'sent' } })) === 8, 25_000)
    const times = smtp.received.map((r) => r.at).sort((a, b) => a - b)
    expect(times).toHaveLength(8)
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(200) // 250ms interval, minus network jitter
    expect(new Set(smtp.received.map((r) => r.to[0])).size).toBe(8) // each recipient exactly once
    for (const r of rows) expect((await dbEmail(r.id)).attemptCount).toBe(1) // throttle deferrals were not counted as attempts
    await done()
  }, 40_000)

  it('hourly limit of 3 with 10 emails due together: exactly 3 sent, 7 durably deferred to the next hour in BullMQ and PostgreSQL', async () => {
    const { smtp, stack, done } = await env()
    const fx = await createFixture(prisma)
    users.push(fx.userId)
    const rows = await Promise.all(Array.from({ length: 10 }, (_, i) => createEmail(prisma, fx, { index: i })))
    await stack.queue.enqueue(rows.map(queueEmail))
    stack.startWorker({ concurrency: 4, globalPerHour: 3 })
    stack.startWorker({ concurrency: 4, globalPerHour: 3 })
    const ids = rows.map((r) => r.id)
    // Deferrals are instant while the 3 admitted sends are still in flight: wait for BOTH conditions.
    await waitFor(async () => (await stack.inspector.getJobCountByTypes('delayed')) === 7 && (await prisma.email.count({ where: { id: { in: ids }, status: 'sent' } })) === 3, 20_000)
    expect(await prisma.email.count({ where: { id: { in: ids }, status: 'sent' } })).toBe(3)
    expect(smtp.received).toHaveLength(3)
    const deferred = await prisma.email.findMany({ where: { id: { in: ids }, status: 'scheduled' } })
    expect(deferred).toHaveLength(7)
    expect(await prisma.email.count({ where: { id: { in: ids }, status: 'failed' } })).toBe(0) // never permanently failed
    for (const e of deferred) {
      expect(e.attemptCount).toBe(0) // a deferral is not a delivery attempt
      expect(e.scheduledAt.getTime()).toBeGreaterThan(Date.now())
      expect(e.scheduledAt.getTime()).toBeLessThanOrEqual(Date.now() + HOUR + 3600)
    }
    // BullMQ holds the same future time as PostgreSQL
    const jobs = await stack.inspector.getJobs(['delayed'])
    expect(jobs).toHaveLength(7)
    for (const j of jobs) {
      const e = deferred.find((x) => x.id === j.data.emailId)!
      expect(Math.abs(j.timestamp + j.delay - e.scheduledAt.getTime())).toBeLessThan(2000)
      expect(j.attemptsMade).toBe(0) // BullMQ retry budget untouched
    }
    await done()
  }, 40_000)

  it('per-sender limits are enforced independently, and a campaign limit cannot exceed the sender cap', async () => {
    const { smtp, stack, done } = await env()
    const a = await createFixture(prisma, { campaignLimit: 50 }) // asks for 50/hour...
    const b = await createFixture(prisma)
    users.push(a.userId, b.userId)
    const rowsA = await Promise.all(Array.from({ length: 5 }, (_, i) => createEmail(prisma, a, { index: i })))
    const rowsB = await Promise.all(Array.from({ length: 5 }, (_, i) => createEmail(prisma, b, { index: i + 10 })))
    await stack.queue.enqueue([...rowsA, ...rowsB].map(queueEmail))
    stack.startWorker({ concurrency: 5, senderCap: 2 }) // ...but the configured sender cap is 2
    await waitFor(
      async () =>
        (await stack.inspector.getJobCountByTypes('delayed')) === 6 &&
        (await prisma.email.count({ where: { campaignId: { in: [a.campaignId, b.campaignId] }, status: 'sent' } })) === 4,
      20_000,
    )
    expect(await prisma.email.count({ where: { campaignId: a.campaignId, status: 'sent' } })).toBe(2)
    expect(await prisma.email.count({ where: { campaignId: b.campaignId, status: 'sent' } })).toBe(2)
    expect(smtp.received).toHaveLength(4)
    await done()
  }, 40_000)

  it('50 emails from one sender under heavy concurrency never exceed the hourly allowance', async () => {
    const { smtp, stack, done } = await env()
    const fx = await createFixture(prisma)
    users.push(fx.userId)
    const rows = await Promise.all(Array.from({ length: 50 }, (_, i) => createEmail(prisma, fx, { index: i })))
    await stack.queue.enqueue(rows.map(queueEmail))
    for (let i = 0; i < 3; i++) stack.startWorker({ concurrency: 8, globalPerHour: 1000, senderCap: 12 })
    await waitFor(async () => (await stack.inspector.getJobCountByTypes('delayed')) === 38, 25_000)
    await sleep(300) // give any (incorrect) extra sends a chance to show up
    expect(smtp.received).toHaveLength(12)
    expect(await prisma.email.count({ where: { campaignId: fx.campaignId, status: 'sent' } })).toBe(12)
    await done()
  }, 40_000)

  it('transient failures retry with exponential backoff, then succeed (attempts counted, SMTP seen 3 times)', async () => {
    const { smtp, stack, done } = await env({ attempts: 4, backoffMs: 300 })
    smtp.setBehavior((n) => (n <= 2 ? { kind: 'reject-data', code: 451 } : { kind: 'accept' }))
    const fx = await createFixture(prisma)
    users.push(fx.userId)
    const e = await createEmail(prisma, fx)
    await stack.queue.enqueue([queueEmail(e)])
    stack.startWorker()
    await waitFor(async () => (await dbEmail(e.id)).status === 'sent', 15_000)
    const t = smtp.attempts.map((a) => a.at)
    expect(t).toHaveLength(3)
    expect(t[1]! - t[0]!).toBeGreaterThanOrEqual(250) // 300ms * 2^0
    expect(t[2]! - t[1]!).toBeGreaterThanOrEqual(550) // 300ms * 2^1
    expect(await dbEmail(e.id)).toMatchObject({ status: 'sent', attemptCount: 3, failureReason: null })
    await done()
  }, 30_000)

  it('a permanent 550 fails after exactly one attempt', async () => {
    const { smtp, stack, done } = await env({ attempts: 5, backoffMs: 100 })
    smtp.setBehavior(() => ({ kind: 'reject-rcpt', code: 550 }))
    const fx = await createFixture(prisma)
    users.push(fx.userId)
    const e = await createEmail(prisma, fx)
    await stack.queue.enqueue([queueEmail(e)])
    stack.startWorker()
    await waitFor(async () => (await dbEmail(e.id)).status === 'failed', 10_000)
    await sleep(800) // a wrongly-retried job would reach the server again by now
    expect(smtp.stats.rcptCalls).toBe(1)
    expect(await dbEmail(e.id)).toMatchObject({ status: 'failed', attemptCount: 1 })
    await done()
  }, 20_000)

  it('a timeout after the body was sent is UNCERTAIN and is NOT retried (no duplicate)', async () => {
    const { smtp, stack, done } = await env({ attempts: 5, backoffMs: 100, smtpTimeoutMs: 600 })
    smtp.setBehavior(() => ({ kind: 'hang-after-data' }))
    const fx = await createFixture(prisma)
    users.push(fx.userId)
    const e = await createEmail(prisma, fx)
    await stack.queue.enqueue([queueEmail(e)])
    stack.startWorker()
    await waitFor(async () => (await dbEmail(e.id)).status === 'failed', 10_000)
    await sleep(1200)
    expect(smtp.attempts).toHaveLength(1)
    expect((await dbEmail(e.id)).failureReason).toMatch(/UNCERTAIN/)
    await done()
  }, 20_000)

  it('repeated and concurrent queue recovery creates one job and exactly one logical send', async () => {
    const { smtp, stack, done } = await env()
    const fx = await createFixture(prisma)
    users.push(fx.userId)
    const e = await createEmail(prisma, fx, { scheduledAt: new Date(Date.now() + 1200) })
    const q = queueEmail(e)
    await Promise.all([stack.queue.ensureJob([q]), stack.queue.ensureJob([q]), stack.queue.enqueue([q]), stack.queue.ensureJob([q])])
    await prisma.queueOutbox.create({ data: { emailId: e.id, jobId: e.jobId! } })
    const recovery = new QueueRecoveryService(prisma, stack.queue)
    await Promise.all([recovery.reconcile(), recovery.reconcile(), recovery.reconcile()])
    await recovery.recoverStaleProcessing(60_000)
    expect(await stack.inspector.getJobCounts('delayed', 'waiting', 'active', 'completed', 'failed')).toMatchObject({ delayed: 1, waiting: 0 })
    stack.startWorker()
    await waitFor(async () => (await dbEmail(e.id)).status === 'sent', 10_000)
    await recovery.reconcile()
    await recovery.recoverStaleProcessing(60_000)
    await sleep(500)
    expect(smtp.received).toHaveLength(1)
    expect((await dbEmail(e.id)).attemptCount).toBe(1)
    await done()
  }, 25_000)

  it('ensureJob recreates a job that disappeared, and replaces a retained completed one', async () => {
    const { stack, done } = await env()
    const fx = await createFixture(prisma)
    users.push(fx.userId)
    const e = await createEmail(prisma, fx, { scheduledAt: new Date(Date.now() + 60_000) })
    await stack.queue.ensureJob([queueEmail(e)])
    const job = await stack.inspector.getJob(e.jobId!)
    expect(await job!.getState()).toBe('delayed')
    await job!.remove()
    expect(await stack.inspector.getJob(e.jobId!)).toBeUndefined()
    await stack.queue.ensureJob([queueEmail(e)])
    expect(await (await stack.inspector.getJob(e.jobId!))!.getState()).toBe('delayed')
    await done()
  })

  it('pending jobs survive an API restart and a worker restart; the email is sent once', async () => {
    const { smtp, stack, done } = await env()
    const fx = await createFixture(prisma)
    users.push(fx.userId)
    const e = await createEmail(prisma, fx, { scheduledAt: new Date(Date.now() + 1500) })
    await stack.queue.enqueue([queueEmail(e)])
    // "API restart": a brand-new queue client (new Redis connection) sees the same delayed job.
    const second = createStack({ prisma, smtpCredentials: smtp.credentials })
    const probe = new (await import('bullmq')).Queue(stack.queueName, { connection: { host: 'localhost', port: 6379 } })
    expect(await probe.getJobCountByTypes('delayed')).toBe(1)
    await probe.close()
    await second.close()
    // "Worker restart": worker 1 starts and stops before the job is due; worker 2 delivers it.
    const w1 = stack.startWorker()
    await sleep(200)
    await w1.close()
    expect((await dbEmail(e.id)).status).toBe('scheduled')
    stack.startWorker()
    await waitFor(async () => (await dbEmail(e.id)).status === 'sent', 10_000)
    await sleep(300)
    expect(smtp.received).toHaveLength(1)
    await done()
  }, 25_000)

  it('graceful shutdown lets an in-flight delivery finish instead of dropping it', async () => {
    const { smtp, stack, done } = await env({ acceptDelayMs: 500 })
    const fx = await createFixture(prisma)
    users.push(fx.userId)
    const e = await createEmail(prisma, fx)
    await stack.queue.enqueue([queueEmail(e)])
    const w = stack.startWorker()
    await waitFor(async () => (await dbEmail(e.id)).status === 'processing', 8000, 15)
    await w.close() // SIGTERM equivalent: waits for the active job
    expect(await dbEmail(e.id)).toMatchObject({ status: 'sent', attemptCount: 1 })
    expect(smtp.received).toHaveLength(1)
    await done()
  }, 20_000)
})

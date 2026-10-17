import type { PrismaClient } from '@prisma/client'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPrisma } from '../src/config/prisma'
import { campaignRepository } from '../src/repositories/campaign.repository'
import { buildTestApp, iso, validBody } from './helpers'

// Requires a migrated PostgreSQL. Skipped (and reported as skipped) when DATABASE_URL is unset.
const url = process.env.DATABASE_URL
const d = url ? describe : describe.skip

d('POST /api/emails/schedule (real PostgreSQL)', () => {
  let prisma: PrismaClient
  let app: ReturnType<typeof buildTestApp>
  const tag = `s${Date.now().toString(36)}`
  const userEmail = (n: string) => `${tag}-${n}@users.example.com`
  const uniq = () => `${tag}-key-${Math.random().toString(36).slice(2, 12)}`

  const schedule = (body: unknown, as = 'alice', headers: Record<string, string> = {}) =>
    request(app)
      .post('/api/emails/schedule')
      .set('X-Test-User-Email', userEmail(as))
      .set('Origin', 'http://localhost:3000')
      .set(headers)
      .send(body as object)

  beforeAll(() => {
    prisma = createPrisma(url!)
    app = buildTestApp(prisma, { maxRecipientsPerBatch: 1000, maxHourlyLimit: 100 })
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: tag } } }) // cascades to everything else
    await prisma.$disconnect()
  })

  it('persists one campaign and one email row per unique, normalized recipient', async () => {
    const res = await schedule(
      validBody({
        to: ['One@Example.com', { email: ' two@example.com ', name: 'Two' }, 'one@example.com', 'three@example.com'],
        scheduledAt: iso(3_600_000),
        subject: '  Launch  ',
        bodyHtml: '<p>Hello <b>world</b><script>x()</script></p>',
      }),
    )
    expect(res.status).toBe(201)
    expect(res.headers['idempotency-replayed']).toBe('false')
    expect(res.body.recipients).toEqual({ accepted: 3, submitted: 4, duplicatesRemoved: 1 })
    expect(res.body.emails.map((e: { to: string }) => e.to)).toEqual(['one@example.com', 'two@example.com', 'three@example.com'])

    const rows = await prisma.email.findMany({ where: { campaignId: res.body.campaign.id }, orderBy: { id: 'asc' } })
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.status).toBe('scheduled')
      expect(r.subject).toBe('Launch')
      expect(r.bodyHtml).not.toContain('script')
      expect(r.bodyText).toBe('Hello world')
      expect(r.attemptCount).toBe(0)
      expect(r.jobId).toBe(`email_${r.id}`)
    }
    expect(rows.find((r) => r.recipientEmail === 'two@example.com')?.recipientName).toBe('Two')

    const owner = await prisma.user.findUniqueOrThrow({ where: { email: userEmail('alice') } })
    expect(rows.every((r) => r.ownerId === owner.id)).toBe(true)
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: res.body.campaign.id } })
    expect(campaign.recipientCount).toBe(3)
    expect(campaign.requestHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('materializes campaign pacing into per-recipient scheduledAt', async () => {
    const start = iso(3_600_000)
    const res = await schedule(validBody({ to: ['p1@x.io', 'p2@x.io', 'p3@x.io'], scheduledAt: start, delayBetweenSeconds: 30, hourlyLimit: 50 }))
    expect(res.status).toBe(201)
    const times = res.body.emails.map((e: { scheduledAt: string }) => new Date(e.scheduledAt).getTime())
    expect(times[1] - times[0]).toBe(30_000)
    expect(times[2] - times[1]).toBe(30_000)
    expect(res.body.campaign).toMatchObject({ delaySeconds: 30, hourlyLimit: 50, recipientCount: 3 })
  })

  it('schedules "now" when scheduledAt is omitted and clamps skew up to a minute', async () => {
    const before = Date.now()
    const a = await schedule(validBody())
    const b = await schedule(validBody({ scheduledAt: iso(-30_000) }))
    for (const res of [a, b]) {
      expect(res.status).toBe(201)
      expect(new Date(res.body.emails[0].scheduledAt).getTime()).toBeGreaterThanOrEqual(before)
    }
  })

  it('replays a retried request with the same idempotency key without creating rows', async () => {
    const key = uniq()
    const body = validBody({ to: ['r1@x.io', 'r2@x.io'], scheduledAt: iso(3_600_000) })
    const first = await schedule(body, 'alice', { 'Idempotency-Key': key })
    const second = await schedule(body, 'alice', { 'Idempotency-Key': key })
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(second.headers['idempotency-replayed']).toBe('true')
    expect(second.body.campaign.id).toBe(first.body.campaign.id)
    expect(second.body.emails.map((e: { id: string }) => e.id)).toEqual(first.body.emails.map((e: { id: string }) => e.id))
    expect(await prisma.email.count({ where: { idempotencyKey: { startsWith: `${key}#` } } })).toBe(2)
    expect(await prisma.campaign.count({ where: { idempotencyKey: key } })).toBe(1)
  })

  it('replays an immediate send even though "now" has moved on', async () => {
    const key = uniq()
    const first = await schedule(validBody(), 'alice', { 'Idempotency-Key': key })
    await new Promise((r) => setTimeout(r, 25))
    const second = await schedule(validBody(), 'alice', { 'Idempotency-Key': key })
    expect(second.status).toBe(200)
    expect(second.body.campaign.id).toBe(first.body.campaign.id)
  })

  it('accepts the key in the body as well as the header', async () => {
    const key = uniq()
    const a = await schedule(validBody({ idempotencyKey: key }))
    const b = await schedule(validBody({ idempotencyKey: key }))
    expect([a.status, b.status]).toEqual([201, 200])
    expect(a.body.idempotencyKey).toBe(key)
  })

  it('answers 409 when a key is reused with a different payload', async () => {
    const key = uniq()
    await schedule(validBody({ subject: 'First' }), 'alice', { 'Idempotency-Key': key })
    const res = await schedule(validBody({ subject: 'Second' }), 'alice', { 'Idempotency-Key': key })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('scopes idempotency keys per user', async () => {
    const key = uniq()
    const a = await schedule(validBody(), 'alice', { 'Idempotency-Key': key })
    const b = await schedule(validBody(), 'bob', { 'Idempotency-Key': key })
    expect([a.status, b.status]).toEqual([201, 201])
    expect(a.body.campaign.id).not.toBe(b.body.campaign.id)
    const bob = await prisma.user.findUniqueOrThrow({ where: { email: userEmail('bob') } })
    expect(await prisma.email.count({ where: { campaignId: b.body.campaign.id, ownerId: bob.id } })).toBe(1)
  })

  it('ignores a client-supplied owner id', async () => {
    const alice = await prisma.user.findUniqueOrThrow({ where: { email: userEmail('alice') } })
    const res = await schedule(validBody({ ownerId: alice.id, userId: alice.id }), 'carol')
    expect(res.status).toBe(201)
    const carol = await prisma.user.findUniqueOrThrow({ where: { email: userEmail('carol') } })
    const row = await prisma.email.findFirstOrThrow({ where: { campaignId: res.body.campaign.id } })
    expect(row.ownerId).toBe(carol.id)
  })

  it('reuses one sender row per owner and address', async () => {
    const from = `${tag}-shared@sender.example.com`
    await schedule(validBody({ from }), 'dave')
    await schedule(validBody({ from: from.toUpperCase() }), 'dave')
    const dave = await prisma.user.findUniqueOrThrow({ where: { email: userEmail('dave') } })
    expect(await prisma.sender.count({ where: { ownerId: dave.id, email: from } })).toBe(1)
  })

  it('is all-or-nothing: a failure while inserting emails leaves no campaign or sender behind', async () => {
    const key = uniq()
    const from = `${tag}-atomic@sender.example.com`
    vi.spyOn(campaignRepository, 'createEmails').mockRejectedValueOnce(new Error('simulated crash'))
    const res = await schedule(validBody({ from }), 'erin', { 'Idempotency-Key': key })
    expect(res.status).toBe(500)
    expect(await prisma.campaign.count({ where: { idempotencyKey: key } })).toBe(0)
    expect(await prisma.email.count({ where: { idempotencyKey: { startsWith: `${key}#` } } })).toBe(0)
    expect(await prisma.sender.count({ where: { email: from } })).toBe(0)
    // and the same key works afterwards
    const retry = await schedule(validBody({ from }), 'erin', { 'Idempotency-Key': key })
    expect(retry.status).toBe(201)
  })

  it('creates exactly one campaign for 50 simultaneous requests with the same key', async () => {
    const key = uniq()
    const body = validBody({ to: ['c1@x.io', 'c2@x.io', 'c3@x.io'], scheduledAt: iso(3_600_000) })
    const results = await Promise.all(Array.from({ length: 50 }, () => schedule(body, 'frank', { 'Idempotency-Key': key })))
    const statuses = results.map((r) => r.status)
    expect(statuses.every((s) => s === 200 || s === 201), JSON.stringify(statuses)).toBe(true)
    expect(statuses.filter((s) => s === 201)).toHaveLength(1)
    expect(new Set(results.map((r) => r.body.campaign.id)).size).toBe(1)
    expect(await prisma.campaign.count({ where: { idempotencyKey: key } })).toBe(1)
    expect(await prisma.email.count({ where: { idempotencyKey: { startsWith: `${key}#` } } })).toBe(3)
  })

  it('handles 50 simultaneous requests with distinct keys and no cross-talk', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        schedule(validBody({ to: [`n${i}-a@x.io`, `n${i}-b@x.io`], scheduledAt: iso(3_600_000) }), 'gina', { 'Idempotency-Key': uniq() }),
      ),
    )
    expect(results.every((r) => r.status === 201)).toBe(true)
    expect(new Set(results.map((r) => r.body.campaign.id)).size).toBe(50)
    const gina = await prisma.user.findUniqueOrThrow({ where: { email: userEmail('gina') } })
    expect(await prisma.email.count({ where: { ownerId: gina.id } })).toBe(100)
  })

  it('accepts a full-size batch (1000 recipients) in one transaction', async () => {
    const to = Array.from({ length: 1000 }, (_, i) => `bulk${i}@x.io`)
    const res = await schedule(validBody({ to, scheduledAt: iso(3_600_000), delayBetweenSeconds: 2 }), 'hank')
    expect(res.status).toBe(201)
    expect(res.body.emails).toHaveLength(1000)
    expect(await prisma.email.count({ where: { campaignId: res.body.campaign.id } })).toBe(1000)
    // original order is recoverable from ids alone
    const ordered = await prisma.email.findMany({ where: { campaignId: res.body.campaign.id }, orderBy: { id: 'asc' }, select: { recipientEmail: true } })
    expect(ordered.map((r) => r.recipientEmail)).toEqual(to)
  })

  it('rejects an over-limit batch and writes nothing', async () => {
    const to = Array.from({ length: 1001 }, (_, i) => `over${i}@x.io`)
    const before = await prisma.campaign.count()
    const res = await schedule(validBody({ to }), 'ivy')
    expect(res.status).toBe(400)
    expect(await prisma.campaign.count()).toBe(before)
  })
})

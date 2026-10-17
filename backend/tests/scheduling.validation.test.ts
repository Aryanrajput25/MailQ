import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { buildTestApp, iso, validBody } from './helpers'

// Prisma stub: validation must fail BEFORE any database access, so any DB call here is a bug.
const explodingPrisma = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === 'then') return undefined
      throw new Error(`database touched (${String(prop)}) during a request that should fail validation`)
    },
  },
) as never

function appNoDb(limits = {}) {
const prisma = {
  user: { upsert: async () => ({ id: 'u1', email: 'dev@example.com', name: 'dev' }) },
    $transaction: async () => {
      throw new Error('transaction must not start for invalid requests')
    },
  } as never
  void explodingPrisma
  return buildTestApp(prisma, limits)
}

const post = (app: ReturnType<typeof appNoDb>, body: unknown, headers: Record<string, string> = {}) =>
  request(app)
    .post('/api/emails/schedule')
    .set('X-Test-User-Email', 'dev@example.com')
    .set('Origin', 'http://localhost:3000')
    .set(headers)
    .send(body as object)

const paths = (res: request.Response) => (res.body.error.details as { path: string }[]).map((d) => d.path)

describe('POST /api/emails/schedule - validation (no database)', () => {
  it('requires authentication', async () => {
    const res = await request(appNoDb()).post('/api/emails/schedule').set('Origin', 'http://localhost:3000').send(validBody())
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('does not accept the former development identity header', async () => {
    const res = await request(appNoDb())
      .post('/api/emails/schedule')
      .set('Origin', 'http://localhost:3000')
      .set('X-Dev-User-Email', 'anyone@example.com')
      .send(validBody())
    expect(res.status).toBe(401)
  })

  it('rejects an empty body with field errors', async () => {
    const res = await post(appNoDb(), {})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(paths(res)).toEqual(expect.arrayContaining(['from', 'to', 'subject', 'bodyHtml']))
  })

  it('reports every invalid recipient with its index', async () => {
    const res = await post(appNoDb(), validBody({ to: ['ok@example.com', 'nope', 'a@b', 'fine@example.com', 'x y@z.com'] }))
    expect(res.status).toBe(400)
    expect(paths(res)).toEqual(['to.1', 'to.2', 'to.4'])
  })

  it('rejects header-injection attempts in recipients and subject', async () => {
    const r1 = await post(appNoDb(), validBody({ to: ['a@example.com\r\nBcc: evil@example.com'] }))
    expect(r1.status).toBe(400)
    const r2 = await post(appNoDb(), validBody({ subject: 'Hi\r\nBcc: evil@example.com' }))
    expect(paths(r2)).toContain('subject')
  })

  it('rejects blank subject and markup-only body', async () => {
    const res = await post(appNoDb(), validBody({ subject: '   ', bodyHtml: '<p><br></p>' }))
    expect(paths(res)).toEqual(expect.arrayContaining(['subject', 'bodyHtml']))
  })

  it('rejects an invalid sender', async () => {
    const res = await post(appNoDb(), validBody({ from: 'not-an-email' }))
    expect(paths(res)).toContain('from')
  })

  it('enforces the configurable batch size on unique recipients', async () => {
    const app = appNoDb({ maxRecipientsPerBatch: 3 })
    const tooMany = await post(app, validBody({ to: ['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io'] }))
    expect(tooMany.status).toBe(400)
    expect(tooMany.body.error.details[0].message).toMatch(/maximum is 3/)
    // duplicates do not count towards the limit: this passes validation and reaches the (stubbed) transaction
    const dupes = await post(app, validBody({ to: ['a@x.io', 'A@X.IO', 'b@x.io', 'c@x.io', 'c@x.io'] }))
    expect(dupes.status).toBe(500)
  })

  it.each([
    ['no offset', '2099-01-01T10:00:00'],
    ['date only', '2099-01-01'],
    ['garbage', 'tomorrow'],
    ['impossible date', '2099-02-31T10:00:00Z'],
  ])('rejects malformed scheduledAt (%s)', async (_n, value) => {
    const res = await post(appNoDb(), validBody({ scheduledAt: value }))
    expect(paths(res)).toContain('scheduledAt')
  })

  it('rejects scheduledAt in the past or beyond a year', async () => {
    const past = await post(appNoDb(), validBody({ scheduledAt: iso(-10 * 60_000) }))
    expect(past.body.error.details[0].message).toMatch(/past/)
    const far = await post(appNoDb(), validBody({ scheduledAt: iso(400 * 86_400_000) }))
    expect(far.body.error.details[0].message).toMatch(/year/)
  })

  it('validates hourlyLimit against server bounds and delay as a whole number', async () => {
    const app = appNoDb({ maxHourlyLimit: 100 })
    for (const hourlyLimit of [0, -1, 101, 1.5]) {
      const res = await post(app, validBody({ hourlyLimit }))
      expect(res.status, `hourlyLimit=${hourlyLimit}`).toBe(400)
    }
    for (const delayBetweenSeconds of [-1, 1.5, 99_999]) {
      const res = await post(app, validBody({ delayBetweenSeconds }))
      expect(res.status, `delay=${delayBetweenSeconds}`).toBe(400)
    }
  })

  it('rejects attachments instead of silently dropping them', async () => {
    const res = await post(appNoDb(), validBody({ attachments: [{ id: '1', name: 'a.png' }] }))
    expect(paths(res)).toContain('attachments')
  })

  it('validates idempotency keys and header/body agreement', async () => {
    const short = await post(appNoDb(), validBody(), { 'Idempotency-Key': 'short' })
    expect(paths(short)).toContain('idempotencyKey')
    const differ = await post(appNoDb(), validBody({ idempotencyKey: 'key-number-one' }), { 'Idempotency-Key': 'key-number-two' })
    expect(differ.status).toBe(400)
  })

  it('rejects malformed JSON', async () => {
    const res = await request(appNoDb())
      .post('/api/emails/schedule')
      .set('X-Test-User-Email', 'dev@example.com')
      .set('Content-Type', 'application/json')
      .send('{oops')
    expect(res.body.error.code).toBe('INVALID_JSON')
  })
})

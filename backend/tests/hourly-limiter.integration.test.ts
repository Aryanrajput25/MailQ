import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HourlyLimiter, type ReserveInput } from '../src/services/hourly-limiter.service'
import { cleanPrefix, connections, hasRedis, uniquePrefix } from './helpers/redis'

const HOUR = 3_600_000
const W = 500_000 // an arbitrary window number
const T = W * HOUR + 1234 // a moment inside window W

const d = hasRedis ? describe : describe.skip

d('HourlyLimiter (real Redis, atomic Lua)', () => {
  let conns: Redis[]
  const prefix = uniquePrefix('hl')
  const mk = (tag: string, redis = conns[0]!) => new HourlyLimiter(redis, { prefix: `${prefix}${tag}:` })
  const input = (over: Partial<ReserveInput> = {}): ReserveInput => ({
    emailId: `e${Math.random()}`,
    senderId: 's1',
    campaignId: 'c1',
    globalLimit: 100,
    senderLimit: 100,
    campaignLimit: 0,
    ...over,
  })

  beforeAll(() => {
    conns = connections(5)
  })
  afterAll(async () => {
    await cleanPrefix(conns[0]!, prefix)
    await Promise.all(conns.map((c) => c.quit()))
  })

  it('with a limit of 3 and 10 emails due together, exactly 3 are admitted', async () => {
    const lim = mk('a')
    const results = await Promise.all(Array.from({ length: 10 }, () => lim.reserve(input({ globalLimit: 3 }), T)))
    expect(results.filter((r) => r.granted)).toHaveLength(3)
    const denied = results.filter((r) => !r.granted)
    expect(denied).toHaveLength(7)
    expect(denied[0]).toMatchObject({ scope: 'global', window: W, nextWindowAt: (W + 1) * HOUR })
    expect((await lim.usage(W, 's1', 'c1')).global).toBe(3)
  })

  it('holds under heavy concurrency from 5 separate connections (200 attempts, limit 17)', async () => {
    const limiters = conns.map((c, i) => new HourlyLimiter(c, { prefix: `${prefix}b:` }))
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => limiters[i % 5]!.reserve(input({ senderLimit: 17, globalLimit: 1000 }), T)))
    expect(results.filter((r) => r.granted)).toHaveLength(17)
    expect((await limiters[0]!.usage(W, 's1')).sender).toBe(17)
  })

  it('is replay-safe: the same email reserved repeatedly counts once', async () => {
    const lim = mk('c')
    const first = await lim.reserve(input({ emailId: 'same' }), T)
    expect(first).toMatchObject({ granted: true, replay: false })
    for (let i = 0; i < 5; i++) expect(await lim.reserve(input({ emailId: 'same' }), T)).toMatchObject({ granted: true, replay: true })
    expect((await lim.usage(W, 's1', 'c1')).global).toBe(1)
  })

  it('enforces the per-sender limit independently of other senders', async () => {
    const lim = mk('d')
    const a = await Promise.all(Array.from({ length: 5 }, () => lim.reserve(input({ senderId: 'A', senderLimit: 2 }), T)))
    expect(a.filter((r) => r.granted)).toHaveLength(2)
    expect(a.find((r) => !r.granted)).toMatchObject({ scope: 'sender' })
    expect((await lim.reserve(input({ senderId: 'B', senderLimit: 2 }), T)).granted).toBe(true)
  })

  it('enforces the per-campaign limit', async () => {
    const lim = mk('e')
    const r = await Promise.all(Array.from({ length: 6 }, () => lim.reserve(input({ campaignId: 'camp', campaignLimit: 4 }), T)))
    expect(r.filter((x) => x.granted)).toHaveLength(4)
    expect(r.find((x) => !x.granted)).toMatchObject({ scope: 'campaign' })
  })

  it('a campaign limit larger than the global cap cannot bypass the global cap', async () => {
    const lim = mk('f')
    const r = await Promise.all(Array.from({ length: 10 }, () => lim.reserve(input({ campaignLimit: 50, globalLimit: 3 }), T)))
    expect(r.filter((x) => x.granted)).toHaveLength(3)
  })

  it('is all-or-nothing: a sender denial does not consume global or campaign capacity', async () => {
    const lim = mk('g')
    await lim.reserve(input({ senderId: 'S', senderLimit: 1 }), T)
    const before = await lim.usage(W, 'S', 'c1')
    const denied = await lim.reserve(input({ senderId: 'S', senderLimit: 1 }), T)
    expect(denied.granted).toBe(false)
    expect(await lim.usage(W, 'S', 'c1')).toEqual(before)
  })

  it('uses UTC calendar-hour windows: capacity resets exactly at HH:00:00Z', async () => {
    const lim = mk('h')
    const lastMs = (W + 1) * HOUR - 1
    expect((await lim.reserve(input({ globalLimit: 1 }), lastMs)).granted).toBe(true)
    const blocked = await lim.reserve(input({ globalLimit: 1 }), lastMs)
    expect(blocked).toMatchObject({ granted: false, window: W, nextWindowAt: (W + 1) * HOUR })
    const nextHour = await lim.reserve(input({ globalLimit: 1 }), (W + 1) * HOUR)
    expect(nextHour).toMatchObject({ granted: true, window: W + 1 })
  })

  it('releases a stale reservation from an earlier window when the email is re-reserved later', async () => {
    const lim = mk('i')
    await lim.reserve(input({ emailId: 'late' }), T)
    expect((await lim.usage(W, 's1', 'c1')).global).toBe(1)
    const later = await lim.reserve(input({ emailId: 'late' }), T + HOUR)
    expect(later).toMatchObject({ granted: true, replay: false, window: W + 1 })
    expect((await lim.usage(W, 's1', 'c1')).global).toBe(0) // old window refunded, never double counted
    expect((await lim.usage(W + 1, 's1', 'c1')).global).toBe(1)
  })

  it('refund frees capacity once, and is idempotent', async () => {
    const lim = mk('j')
    await lim.reserve(input({ emailId: 'r1', globalLimit: 1 }), T)
    expect((await lim.reserve(input({ emailId: 'r2', globalLimit: 1 }), T)).granted).toBe(false)
    expect(await lim.refund('r1')).toBe(true)
    expect(await lim.refund('r1')).toBe(false)
    expect((await lim.usage(W, 's1', 'c1')).global).toBe(0)
    expect((await lim.reserve(input({ emailId: 'r2', globalLimit: 1 }), T)).granted).toBe(true)
  })

  it('refund of an unknown email is a harmless no-op', async () => {
    expect(await mk('k').refund('never-reserved')).toBe(false)
  })

  it('counters expire so Redis does not accumulate old windows', async () => {
    const lim = mk('l')
    await lim.reserve(input({ emailId: 'ttl' }))
    const keys = await conns[0]!.keys(`${prefix}l:*`)
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect(await conns[0]!.ttl(k)).toBeGreaterThan(0)
  })
})

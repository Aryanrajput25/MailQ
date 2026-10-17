import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SendThrottle } from '../src/services/send-throttle.service'
import { cleanPrefix, connections, hasRedis, uniquePrefix } from './helpers/redis'

describe('SendThrottle - zero delay', () => {
  it('MIN_DELAY_MS=0 always grants and never touches Redis', async () => {
    const explosive = new Proxy({}, { get: () => () => { throw new Error('Redis must not be used when the interval is 0') } }) as unknown as Redis
    const t = new SendThrottle(Object.assign(explosive, { defineCommand: () => undefined }) as never, { minIntervalMs: 0 })
    for (let i = 0; i < 5; i++) expect((await t.tryAcquire()).granted).toBe(true)
  })
})

const d = hasRedis ? describe : describe.skip

d('SendThrottle (real Redis)', () => {
  let conns: Redis[]
  const prefix = uniquePrefix('thr')

  beforeAll(() => {
    conns = connections(6)
  })
  afterAll(async () => {
    await cleanPrefix(conns[0]!, prefix)
    await Promise.all(conns.map((c) => c.quit()))
  })

  it('grants then denies with the exact remaining wait (deterministic clock)', async () => {
    const t = new SendThrottle(conns[0]!, { minIntervalMs: 2000, prefix: `${prefix}a:` })
    expect(await t.tryAcquire(10_000)).toEqual({ granted: true, at: 10_000 })
    expect(await t.tryAcquire(10_500)).toEqual({ granted: false, waitMs: 1500 })
    expect(await t.tryAcquire(11_999)).toEqual({ granted: false, waitMs: 1 })
    expect(await t.tryAcquire(12_000)).toEqual({ granted: true, at: 12_000 })
  })

  it('a denied attempt writes nothing: it neither consumes nor extends the slot', async () => {
    const p = `${prefix}b:`
    const t = new SendThrottle(conns[0]!, { minIntervalMs: 5000, prefix: p })
    await t.tryAcquire(1_000_000)
    const key = `${p}send:next`
    const before = { v: await conns[0]!.get(key), ttl: await conns[0]!.pttl(key) }
    for (let i = 0; i < 50; i++) expect((await t.tryAcquire(1_000_100 + i)).granted).toBe(false)
    expect(await conns[0]!.get(key)).toBe(before.v)
    expect(await conns[0]!.pttl(key)).toBeLessThanOrEqual(before.ttl)
  })

  it('the slot key expires on its own (no stale reservation can block forever)', async () => {
    const p = `${prefix}c:`
    const t = new SendThrottle(conns[0]!, { minIntervalMs: 100, prefix: p })
    await t.tryAcquire()
    const ttl = await conns[0]!.pttl(`${p}send:next`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(1100) // interval + 1s safety margin, then gone
  })

  it('real clock: spacing between ANY two grants is >= the interval across 6 "workers" competing', async () => {
    const interval = 60
    const p = `${prefix}d:`
    const grants: number[] = []
    const stopAt = Date.now() + 1500
    const worker = async (redis: Redis) => {
      const t = new SendThrottle(redis, { minIntervalMs: interval, prefix: p })
      while (Date.now() < stopAt) {
        const r = await t.tryAcquire()
        if (r.granted) grants.push(r.at)
        else await new Promise((res) => setTimeout(res, Math.max(1, r.waitMs)))
      }
    }
    // 6 connections x 4 concurrent loops each = 24 competing callers
    await Promise.all(conns.flatMap((c) => Array.from({ length: 4 }, () => worker(c))))
    grants.sort((a, b) => a - b)
    expect(grants.length).toBeGreaterThan(10) // liveness: the throttle keeps handing out slots
    for (let i = 1; i < grants.length; i++) expect(grants[i]! - grants[i - 1]!).toBeGreaterThanOrEqual(interval)
    expect(grants.length).toBeLessThanOrEqual(Math.floor(1500 / interval) + 1) // and never faster than the cap
  })

  it('a burst of 300 simultaneous attempts yields exactly one grant', async () => {
    const p = `${prefix}e:`
    const results = await Promise.all(
      Array.from({ length: 300 }, (_, i) => new SendThrottle(conns[i % conns.length]!, { minIntervalMs: 10_000, prefix: p }).tryAcquire()),
    )
    expect(results.filter((r) => r.granted)).toHaveLength(1)
  })
})

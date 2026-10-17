import type { Redis } from 'ioredis'

/**
 * GLOBAL PROVIDER THROTTLE: at most one send per `minIntervalMs` across every worker and process.
 *
 * One Redis key holds "the earliest instant the next send may start". A single Lua script (atomic in
 * Redis) reads the time from the Redis server clock - never from a worker - and either:
 *   - GRANTS: now >= next  ->  next := now + interval, caller sends now; or
 *   - DENIES: returns how long to wait, and writes NOTHING.
 *
 * Why grant-or-deny instead of handing out future slots:
 *   - A job that cannot send now defers itself (BullMQ delay) without holding a slot. A cancelled,
 *     failed or crashed job therefore can never leave a reserved-but-unused slot blocking others.
 *   - A slot is only consumed by a send that is actually about to happen, so spacing is exact.
 *   - There is no stale state: the key expires by itself, and an expired key is the same as "free".
 * Slots are never "released": returning one would allow two sends closer than the interval.
 *
 * Requires Redis >= 5 (script effects replication, so TIME may precede writes). Single Redis node.
 */
const RESERVE_SLOT = `
local interval = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local override = ARGV[3]
local now
if override ~= '' then
  now = tonumber(override)
else
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local nextAt = tonumber(redis.call('GET', KEYS[1]) or '0')
if nextAt <= now then
  redis.call('SET', KEYS[1], tostring(now + interval), 'PX', ttl)
  return {1, 0, now}
end
return {0, nextAt - now, now}
`

type ThrottleRedis = Redis & { reserveSendSlot?: (key: string, interval: string, ttl: string, nowOverride: string) => Promise<[number, number, number]> }

export type ThrottleResult = { granted: true; at: number } | { granted: false; waitMs: number }

export interface SendThrottleOptions {
  /** 0 disables throttling entirely (no Redis round-trip). */
  minIntervalMs: number
  prefix?: string
}

export class SendThrottle {
  private readonly key: string

  constructor(private readonly redis: Redis, private readonly options: SendThrottleOptions) {
    this.key = `${options.prefix ?? 'rl:'}send:next`
    const r = redis as ThrottleRedis
    if (!r.reserveSendSlot) redis.defineCommand('reserveSendSlot', { numberOfKeys: 1, lua: RESERVE_SLOT })
  }

  /** `nowOverrideMs` exists for deterministic tests only; production never passes it. */
  async tryAcquire(nowOverrideMs?: number): Promise<ThrottleResult> {
    const interval = this.options.minIntervalMs
    if (interval <= 0) return { granted: true, at: nowOverrideMs ?? Date.now() }
    const [granted, waitMs, at] = await (this.redis as ThrottleRedis).reserveSendSlot!(
      this.key,
      String(interval),
      String(interval + 1000),
      nowOverrideMs === undefined ? '' : String(nowOverrideMs),
    )
    return granted === 1 ? { granted: true, at } : { granted: false, waitMs }
  }
}

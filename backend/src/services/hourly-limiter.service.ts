import type { Redis } from 'ioredis'

/**
 * HOURLY CAPACITY (global + per-sender + per-campaign) in fixed UTC calendar-hour windows.
 *
 * One atomic Lua script checks all three counters and increments them together, or increments none.
 * The window is floor(redisTimeMs / 3_600_000), i.e. it always resets at HH:00:00 UTC, using the Redis
 * server clock so every worker agrees regardless of its own clock.
 *
 * Replay safety: each admission is recorded under `res:<emailId>`. Running the script again for an email
 * that already holds a reservation in the CURRENT window is a no-op that reports granted, so a job that
 * is deferred for another reason (e.g. the send-interval throttle) and comes back never double-counts.
 * If the stored reservation is from an EARLIER window (the email never sent) it is released first, then
 * re-reserved in the current window.
 *
 * Refunds happen only when SMTP was provably never attempted (see `refund`). After an SMTP attempt the
 * capacity stays consumed: a message may have been accepted.
 *
 * Keys are derived inside the script from the Redis clock, so this needs a single Redis node (not Cluster).
 */
const RESERVE = `
local prefix = ARGV[1]
local emailId = ARGV[2]
local senderId = ARGV[3]
local campaignId = ARGV[4]
local gLimit = tonumber(ARGV[5])
local sLimit = tonumber(ARGV[6])
local cLimit = tonumber(ARGV[7])
local override = ARGV[8]
local now
if override ~= '' then
  now = tonumber(override)
else
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local w = math.floor(now / 3600000)
local nextWindow = (w + 1) * 3600000
local TTL = 7200
local resKey = prefix .. 'res:' .. emailId

local function dec(key)
  local v = tonumber(redis.call('GET', key) or '0')
  if v > 0 then redis.call('DECR', key) end
end

local existing = redis.call('GET', resKey)
if existing then
  local ew, es, ec = string.match(existing, '^(%d+)|([^|]*)|([^|]*)$')
  if tonumber(ew) == w then
    return {1, 'replay', w, nextWindow}
  end
  dec(prefix .. 'g:' .. ew)
  dec(prefix .. 's:' .. es .. ':' .. ew)
  if ec ~= '' then dec(prefix .. 'c:' .. ec .. ':' .. ew) end
  redis.call('DEL', resKey)
end

local gKey = prefix .. 'g:' .. w
local sKey = prefix .. 's:' .. senderId .. ':' .. w
local cKey = prefix .. 'c:' .. campaignId .. ':' .. w
if tonumber(redis.call('GET', gKey) or '0') >= gLimit then return {0, 'global', w, nextWindow} end
if tonumber(redis.call('GET', sKey) or '0') >= sLimit then return {0, 'sender', w, nextWindow} end
if campaignId ~= '' and cLimit > 0 and tonumber(redis.call('GET', cKey) or '0') >= cLimit then
  return {0, 'campaign', w, nextWindow}
end

redis.call('INCR', gKey); redis.call('EXPIRE', gKey, TTL)
redis.call('INCR', sKey); redis.call('EXPIRE', sKey, TTL)
if campaignId ~= '' then redis.call('INCR', cKey); redis.call('EXPIRE', cKey, TTL) end
redis.call('SET', resKey, w .. '|' .. senderId .. '|' .. campaignId, 'EX', TTL)
return {1, 'granted', w, nextWindow}
`

const REFUND = `
local prefix = ARGV[1]
local resKey = prefix .. 'res:' .. ARGV[2]
local existing = redis.call('GET', resKey)
if not existing then return 0 end
local ew, es, ec = string.match(existing, '^(%d+)|([^|]*)|([^|]*)$')
local function dec(key)
  local v = tonumber(redis.call('GET', key) or '0')
  if v > 0 then redis.call('DECR', key) end
end
dec(prefix .. 'g:' .. ew)
dec(prefix .. 's:' .. es .. ':' .. ew)
if ec ~= '' then dec(prefix .. 'c:' .. ec .. ':' .. ew) end
redis.call('DEL', resKey)
return 1
`

type LimiterRedis = Redis & {
  reserveHourly?: (...args: string[]) => Promise<[number, string, number, number]>
  refundHourly?: (...args: string[]) => Promise<number>
}

export interface ReserveInput {
  emailId: string
  senderId: string
  campaignId?: string | null
  globalLimit: number
  senderLimit: number
  /** Already clamped by the caller; 0/undefined = no campaign limit. */
  campaignLimit?: number | null
}

export type ReserveResult =
  | { granted: true; replay: boolean; window: number }
  | { granted: false; scope: 'global' | 'sender' | 'campaign'; window: number; nextWindowAt: number }

export class HourlyLimiter {
  private readonly prefix: string

  constructor(private readonly redis: Redis, options: { prefix?: string } = {}) {
    this.prefix = options.prefix ?? 'rl:'
    const r = redis as LimiterRedis
    if (!r.reserveHourly) redis.defineCommand('reserveHourly', { numberOfKeys: 0, lua: RESERVE })
    if (!r.refundHourly) redis.defineCommand('refundHourly', { numberOfKeys: 0, lua: REFUND })
  }

  /** `nowOverrideMs` is for deterministic window tests only. */
  async reserve(input: ReserveInput, nowOverrideMs?: number): Promise<ReserveResult> {
    const [granted, status, window, nextWindowAt] = await (this.redis as LimiterRedis).reserveHourly!(
      this.prefix,
      input.emailId,
      input.senderId,
      input.campaignId ?? '',
      String(input.globalLimit),
      String(input.senderLimit),
      String(input.campaignLimit ?? 0),
      nowOverrideMs === undefined ? '' : String(nowOverrideMs),
    )
    if (granted === 1) return { granted: true, replay: status === 'replay', window }
    return { granted: false, scope: status as 'global' | 'sender' | 'campaign', window, nextWindowAt }
  }

  /** Releases an email's reservation. Safe ONLY when SMTP was never attempted. Idempotent. */
  async refund(emailId: string): Promise<boolean> {
    return (await (this.redis as LimiterRedis).refundHourly!(this.prefix, emailId)) === 1
  }

  async usage(window: number, senderId: string, campaignId?: string): Promise<{ global: number; sender: number; campaign: number }> {
    const n = async (k: string) => Number((await this.redis.get(k)) ?? 0)
    return {
      global: await n(`${this.prefix}g:${window}`),
      sender: await n(`${this.prefix}s:${senderId}:${window}`),
      campaign: campaignId ? await n(`${this.prefix}c:${campaignId}:${window}`) : 0,
    }
  }
}

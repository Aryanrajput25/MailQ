import IORedis, { type Redis } from 'ioredis'

export const REDIS_URL = process.env.REDIS_URL
export const hasRedis = Boolean(REDIS_URL)
export const uniquePrefix = (tag = 't') => `${tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}:`

/** Separate connections model separate worker processes. */
export function connections(n: number): Redis[] {
  return Array.from({ length: n }, () => new IORedis(REDIS_URL!, { maxRetriesPerRequest: 3 }))
}

export async function cleanPrefix(redis: Redis, prefix: string) {
  const keys = await redis.keys(`${prefix}*`)
  if (keys.length) await redis.del(...keys)
}

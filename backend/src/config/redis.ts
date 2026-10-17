import IORedis, { type Redis } from 'ioredis'

/**
 * BullMQ requires `maxRetriesPerRequest: null` on connections used by Workers.
 * Use one connection per role (API client, queue, worker) - never share a blocking connection.
 */
export function createRedis(url: string, opts: { forBullMQ?: boolean } = {}): Redis {
  return new IORedis(url, {
    maxRetriesPerRequest: opts.forBullMQ ? null : 3,
    enableReadyCheck: true,
  })
}

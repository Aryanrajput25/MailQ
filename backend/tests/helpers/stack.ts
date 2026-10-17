import type { PrismaClient } from '@prisma/client'
import { Queue, Worker } from 'bullmq'
import IORedis, { type Redis } from 'ioredis'
import { createApp } from '../../src/app'
import { EmailQueue } from '../../src/queues/email.queue'
import type { AuthService } from '../../src/services/auth.service'
import { HourlyLimiter } from '../../src/services/hourly-limiter.service'
import { SchedulingService } from '../../src/services/scheduling.service'
import { SendThrottle } from '../../src/services/send-throttle.service'
import { SmtpService } from '../../src/services/smtp.service'
import { createEmailProcessor, type ProcessableJob } from '../../src/workers/email.processor'
import { testAuth } from '../helpers'
import { REDIS_URL, uniquePrefix } from './redis'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, timeoutMs = 15_000, everyMs = 40): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    await sleep(everyMs)
  }
}

export interface StackOptions {
  prisma: PrismaClient
  smtpCredentials: { host: string; port: number; user: string; pass: string; secure?: boolean; ignoreTls?: boolean }
  attempts?: number
  backoffMs?: number
  smtpTimeoutMs?: number
}

/** A real BullMQ queue + any number of independent workers (each with its own Redis connections). */
export function createStack(o: StackOptions) {
  const queueName = `email-test-${uniquePrefix('q').replace(':', '')}`
  const limiterPrefix = uniquePrefix('lim')
  const conns: Redis[] = []
  const conn = (forBull = true) => {
    const c = new IORedis(REDIS_URL!, { maxRetriesPerRequest: forBull ? null : 3 })
    conns.push(c)
    return c
  }
  const cfg = { attempts: o.attempts ?? 3, backoffMs: o.backoffMs ?? 200 }
  const queue = new EmailQueue(conn(), cfg, Date.now, queueName)
  const inspector = new Queue(queueName, { connection: conn() })
  const workers: Worker[] = []

  const smtp = new SmtpService({ credentials: o.smtpCredentials, allowAutoCreate: false, timeoutMs: o.smtpTimeoutMs ?? 1500 })

  function startWorker(w: { concurrency?: number; minDelayMs?: number; globalPerHour?: number; senderCap?: number; jitterMs?: number } = {}) {
    const limitConn = conn(false)
    const processor = createEmailProcessor({
      prisma: o.prisma,
      delivery: smtp,
      hourly: new HourlyLimiter(limitConn, { prefix: limiterPrefix }),
      throttle: new SendThrottle(limitConn, { minIntervalMs: w.minDelayMs ?? 0, prefix: limiterPrefix }),
      limits: { globalPerHour: w.globalPerHour ?? 100, senderCapPerHour: w.senderCap ?? 100 },
      staleProcessingMs: 300_000,
      throttleJitterMaxMs: w.jitterMs ?? 15,
    })
    const worker = new Worker(queueName, (job, token) => processor(job as unknown as ProcessableJob, token), {
      connection: conn(),
      concurrency: w.concurrency ?? 3,
      lockDuration: 30_000,
    })
    workers.push(worker)
    return worker
  }

  function app(limits = { maxRecipientsPerBatch: 1000, maxHourlyLimit: 100 }) {
    return createApp({
      config: { FRONTEND_URL: 'http://localhost:3000', isProduction: false },
      prisma: o.prisma,
      health: { prisma: { $queryRaw: (async () => [1]) as never }, redis: { ping: async () => 'PONG' }, elasticsearchUrl: 'http://es.invalid', fetchImpl: (async () => new Response('{}')) as never },
      authenticate: testAuth(o.prisma),
      scheduling: new SchedulingService(o.prisma, limits, Date.now, queue),
      auth: {} as AuthService,
      emailQueue: queue,
    })
  }

  async function close() {
    await Promise.allSettled(workers.map((w) => w.close()))
    await queue.close()
    await inspector.obliterate({ force: true }).catch(() => undefined)
    await inspector.close()
    for (const c of conns) c.disconnect()
  }

  return { queueName, queue, inspector, startWorker, app, close, cfg }
}

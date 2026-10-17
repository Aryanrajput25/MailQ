import { Worker } from 'bullmq'
import { ConfigError, getConfig } from './config'
import { createPrisma } from './config/prisma'
import { createRedis } from './config/redis'
import { EMAIL_QUEUE_NAME, EmailQueue } from './queues/email.queue'
import { HourlyLimiter } from './services/hourly-limiter.service'
import { QueueRecoveryService } from './services/queue-recovery.service'
import { SendThrottle } from './services/send-throttle.service'
import { SmtpService } from './services/smtp.service'
import { SlackService } from './services/slack.service'
import { EmailSearchService } from './services/email-search.service'
import { createEmailProcessor, type ProcessableJob } from './workers/email.processor'
import { logger } from './utils/logger'

/**
 * Email worker process. Runs independently of the API; any number of these may run at once - the
 * global send interval and hourly limits are enforced through Redis, not process memory.
 */
async function main() {
  const config = getConfig()
  const prisma = createPrisma(config.DATABASE_URL)
  const workerRedis = createRedis(config.REDIS_URL, { forBullMQ: true }) // blocking connection owned by the Worker
  const queueRedis = createRedis(config.REDIS_URL, { forBullMQ: true }) // enqueue / recovery
  const limitRedis = createRedis(config.REDIS_URL) // throttle + hourly limiter scripts

  const queue = new EmailQueue(queueRedis, { attempts: config.EMAIL_JOB_ATTEMPTS, backoffMs: config.EMAIL_JOB_BACKOFF_MS })
  const slack = new SlackService(prisma, limitRedis, config.slack, config.TOKEN_ENCRYPTION_KEY)
  const emailSearch = new EmailSearchService(prisma, config.ELASTICSEARCH_URL, config.ELASTICSEARCH_API_KEY)
  const smtp = new SmtpService({
    credentials: config.ethereal,
    // Auto-creating a throwaway Ethereal account is a development convenience only.
    allowAutoCreate: !config.isProduction && !config.ethereal,
    timeoutMs: config.SMTP_TIMEOUT_MS,
  })

  await prisma.$queryRaw`SELECT 1`
  await workerRedis.ping()
  try {
    await smtp.verify()
    logger.info('SMTP connection verified')
  } catch (err) {
    if (config.isProduction) throw err // fail fast on bad SMTP config in production
    logger.warn({ err: (err as Error).message }, 'SMTP verification failed; sends will be retried when the server is reachable')
  }

  const processor = createEmailProcessor({
    prisma,
    delivery: smtp,
    hourly: new HourlyLimiter(limitRedis),
    throttle: new SendThrottle(limitRedis, { minIntervalMs: config.MIN_DELAY_MS }),
    slack,
    limits: { globalPerHour: config.MAX_EMAILS_PER_HOUR, senderCapPerHour: config.MAX_EMAILS_PER_HOUR_PER_SENDER },
    staleProcessingMs: config.STALE_PROCESSING_MS,
  })

  const worker = new Worker(EMAIL_QUEUE_NAME, (job, token) => processor(job as unknown as ProcessableJob, token), {
    connection: workerRedis,
    concurrency: config.WORKER_CONCURRENCY,
    // A crashed worker's lock expires after lockDuration; BullMQ then redelivers the job (stalledCounter > 0).
    lockDuration: 30_000,
    stalledInterval: 30_000,
    maxStalledCount: 1,
  })
  worker.on('error', (err) => logger.error({ err }, 'BullMQ worker error'))
  worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, emailId: job?.data.emailId, attemptsMade: job?.attemptsMade, reason: err.message }, 'email job failed'))
  worker.on('completed', (job, result) => logger.info({ jobId: job.id, emailId: job.data.emailId, result }, 'email job completed'))

  const recovery = new QueueRecoveryService(prisma, queue)
  const reconcile = async () => {
    try {
      const outbox = await recovery.reconcile()
      const stale = await recovery.recoverStaleProcessing(config.STALE_PROCESSING_MS)
      if (outbox.queued || outbox.failed || stale.requeued || stale.uncertain) logger.info({ outbox, stale }, 'queue recovery pass complete')
    } catch (err) {
      logger.error({ err }, 'queue recovery pass failed')
    }
  }
  await reconcile() // startup recovery
  const reconcileSearch = async () => {
    try {
      const result = await emailSearch.reconcile()
      if (result.indexed || result.failed) logger.info(result, 'email search outbox reconciliation complete')
    } catch (err) {
      logger.warn({ err }, 'email search reconciliation unavailable; scheduled emails continue normally')
    }
  }
  void reconcileSearch()
  // This timer only repairs lost handoffs (outbox) and crashed claims; it never decides when mail is sent -
  // BullMQ delayed jobs own execution time.
  const recoveryTimer = setInterval(() => void reconcile(), 30_000)
  recoveryTimer.unref()
  const searchRecoveryTimer = setInterval(() => void reconcileSearch(), 30_000)
  searchRecoveryTimer.unref()
  logger.info({ concurrency: config.WORKER_CONCURRENCY, minDelayMs: config.MIN_DELAY_MS }, 'email worker started')

  let shuttingDown = false
  async function shutdown(signal: string) {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'worker shutting down: waiting for in-flight jobs')
    clearInterval(recoveryTimer)
    clearInterval(searchRecoveryTimer)
    await worker.close() // lets running jobs finish; un-started jobs stay in Redis
    await Promise.allSettled([queue.close(), prisma.$disconnect(), workerRedis.quit(), queueRedis.quit(), limitRedis.quit()])
    logger.info('worker stopped cleanly')
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    // eslint-disable-next-line no-console
    console.error(err.message)
  } else {
    logger.fatal({ err }, 'worker failed to start')
  }
  process.exit(1)
})

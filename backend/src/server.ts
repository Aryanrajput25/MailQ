import type { Server } from 'node:http'
import { createApp } from './app'
import { ConfigError, getConfig } from './config'
import { createPrisma } from './config/prisma'
import { createRedis } from './config/redis'
import { sessionAuthentication } from './middleware/auth'
import { AuthService } from './services/auth.service'
import { SlackService } from './services/slack.service'
import { EmailSearchService } from './services/email-search.service'
import { SchedulingService } from './services/scheduling.service'
import { EmailQueue } from './queues/email.queue'
import { logger } from './utils/logger'

async function main() {
  const config = getConfig()
  const prisma = createPrisma(config.DATABASE_URL)
  const redis = createRedis(config.REDIS_URL)
  const queueRedis = createRedis(config.REDIS_URL, { forBullMQ: true })
  const emailQueue = new EmailQueue(queueRedis, { attempts: config.EMAIL_JOB_ATTEMPTS, backoffMs: config.EMAIL_JOB_BACKOFF_MS })
  const slack = new SlackService(prisma, redis, config.slack, config.TOKEN_ENCRYPTION_KEY)
  const emailSearch = new EmailSearchService(prisma, config.ELASTICSEARCH_URL, config.ELASTICSEARCH_API_KEY)

  const app = createApp({
    config,
    prisma,
    health: {
      prisma,
      redis,
      elasticsearchUrl: config.ELASTICSEARCH_URL,
      elasticsearchApiKey: config.ELASTICSEARCH_API_KEY,
    },
    authenticate: sessionAuthentication(redis, config.SESSION_SECRET),
    scheduling: new SchedulingService(prisma, {
      maxRecipientsPerBatch: config.MAX_RECIPIENTS_PER_BATCH,
      maxHourlyLimit: config.MAX_EMAILS_PER_HOUR_PER_SENDER,
    }, Date.now, emailQueue),
    auth: new AuthService(
      prisma,
      redis,
      config.google,
      config.SESSION_SECRET,
      config.GOOGLE_CALLBACK_URL,
    ),
    slack,
    emailSearch,
    emailQueue,
    bullBoardQueue: emailQueue.getBullMQQueue(),
    bullBoardAdminEmails: config.bullBoardAdminEmails,
  })

  const server: Server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'API listening')
  })

  let shuttingDown = false
  async function shutdown(signal: string) {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'API shutting down: draining connections')
    const force = setTimeout(() => {
      logger.error('forced exit after 10s shutdown timeout')
      process.exit(1)
    }, 10_000)
    force.unref()
    // Stop accepting new connections, let in-flight requests finish.
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await Promise.allSettled([emailQueue.close(), prisma.$disconnect(), redis.quit(), queueRedis.quit()])
    logger.info('API stopped cleanly')
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
    logger.fatal({ err }, 'API failed to start')
  }
  process.exit(1)
})

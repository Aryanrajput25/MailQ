import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'
import pinoHttp from 'pino-http'
import type { RequestHandler } from 'express'
import type { PrismaClient } from '@prisma/client'
import type { Config } from './config/env'
import type { SchedulingPort } from './controllers/email.controller'
import { errorHandler, notFound } from './middleware/error'
import { requireFrontendOrigin } from './middleware/csrf'
import { buildRoutes } from './routes'
import type { HealthDeps } from './services/health.service'
import type { AuthService } from './services/auth.service'
import type { SlackService } from './services/slack.service'
import type { EmailSearchService } from './services/email-search.service'
import type { EmailQueuePort } from './queues/email.queue'
import type { Queue } from 'bullmq'
import type { EmailJobData } from './queues/email.queue'
import { createQueueDashboardRouter } from './middleware/bull-board'
import { logger } from './utils/logger'

export interface AppDeps {
  config: Pick<Config, 'FRONTEND_URL' | 'isProduction'>
  prisma: PrismaClient
  health: HealthDeps
  /** Sets req.user from a Redis-backed session or fails with 401. */
  authenticate: RequestHandler
  scheduling: SchedulingPort
  auth: AuthService
  slack?: SlackService
  emailSearch?: EmailSearchService
  emailQueue?: Pick<EmailQueuePort, 'remove'>
  bullBoardQueue?: Queue<EmailJobData>
  bullBoardAdminEmails?: readonly string[]
}

export function createApp(deps: AppDeps): Express {
  const app = express()
  app.disable('x-powered-by')
  // Needed so `secure` cookies work behind a TLS-terminating proxy in production.
  if (deps.config.isProduction) app.set('trust proxy', 1)

  app.use(helmet())
  app.use(
    pinoHttp({
      logger,
      serializers: {
        req: (req) => ({ method: req.method, url: req.url?.split('?')[0] }),
      },
      autoLogging: { ignore: (req) => req.url?.split('?')[0] === '/api/health' },
    }),
  )
  // Credentialed CORS for the Next.js frontend only (cookie sessions need an explicit origin).
  app.use(cors({ origin: new URL(deps.config.FRONTEND_URL).origin, credentials: true }))
  app.use(express.json({ limit: '2mb' }) /* bounds request size: ~2 MB of JSON per scheduling request */)
  app.use(requireFrontendOrigin(deps.config.FRONTEND_URL))

  if (deps.bullBoardQueue && deps.bullBoardAdminEmails?.length) {
    app.use(
      '/admin/queues',
      createQueueDashboardRouter(deps.bullBoardQueue, deps.authenticate, deps.bullBoardAdminEmails),
    )
  }
  app.use('/api', buildRoutes(deps))
  app.use(notFound)
  app.use(errorHandler)
  return app
}

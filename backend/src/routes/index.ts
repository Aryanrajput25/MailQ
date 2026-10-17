import { Router } from 'express'
import type { AppDeps } from '../app'
import { healthController } from '../controllers/health.controller'
import { buildAuthRoutes } from './auth.routes'
import { buildEmailRoutes } from './email.routes'
import { buildSlackRoutes } from './slack.routes'

export function buildRoutes(deps: AppDeps): Router {
  const router = Router()
  router.get('/health', healthController(deps.health))
  if (deps.slack) {
    router.use('/slack', buildSlackRoutes(deps.slack, deps.authenticate, deps.config.FRONTEND_URL))
  }
  router.use(
    '/auth',
    buildAuthRoutes({
      service: deps.auth,
      authenticate: deps.authenticate,
      frontendUrl: deps.config.FRONTEND_URL,
      secureCookies: deps.config.isProduction,
    }),
  )
  router.use(
    '/emails',
    buildEmailRoutes({
      authenticate: deps.authenticate,
      scheduling: deps.scheduling,
      prisma: deps.prisma,
      queue: deps.emailQueue,
      emailSearch: deps.emailSearch,
    }),
  )
  return router
}

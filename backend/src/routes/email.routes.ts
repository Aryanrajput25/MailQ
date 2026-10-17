import { Router, type RequestHandler } from 'express'
import { scheduleController, type SchedulingPort } from '../controllers/email.controller'
import { buildEmailControllers } from '../controllers/emails.controller'
import type { PrismaClient } from '@prisma/client'
import type { EmailQueuePort } from '../queues/email.queue'
import type { EmailSearchService } from '../services/email-search.service'

export function buildEmailRoutes(deps: {
  authenticate: RequestHandler
  scheduling: SchedulingPort
  prisma: PrismaClient
  queue?: Pick<EmailQueuePort, 'remove'>
  emailSearch?: EmailSearchService
}): Router {
  const router = Router()
  const controllers = buildEmailControllers(deps)
  router.post('/schedule', deps.authenticate, scheduleController(deps.scheduling))
  router.get('/', deps.authenticate, controllers.list)
  router.get('/counts', deps.authenticate, controllers.counts)
  router.get('/search', deps.authenticate, controllers.list)
  router.get('/:id', deps.authenticate, controllers.detail)
  router.patch('/:id/star', deps.authenticate, controllers.setStarred)
  router.post('/:id/cancel', deps.authenticate, controllers.cancel)
  return router
}

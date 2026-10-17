import { Router, type RequestHandler } from 'express'
import type { SlackService } from '../services/slack.service'
import { buildSlackControllers } from '../controllers/slack.controller'

export function buildSlackRoutes(service: SlackService, authenticate: RequestHandler, frontendUrl: string): Router {
  const router = Router()
  const controllers = buildSlackControllers(service, frontendUrl)
  router.get('/connect', authenticate, controllers.connect)
  router.get('/callback', authenticate, controllers.callback)
  router.get('/connection', authenticate, controllers.status)
  router.delete('/connection', authenticate, controllers.disconnect)
  return router
}

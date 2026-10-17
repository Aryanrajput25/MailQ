import { Router } from 'express'
import { buildAuthControllers } from '../controllers/auth.controller'
import type { AuthService } from '../services/auth.service'
import type { RequestHandler } from 'express'

export function buildAuthRoutes(options: {
  service: AuthService
  authenticate: RequestHandler
  frontendUrl: string
  secureCookies: boolean
}): Router {
  const router = Router()
  const controllers = buildAuthControllers(options.service, options)
  router.get('/google', controllers.login)
  router.get('/google/callback', controllers.callback)
  router.get('/me', options.authenticate, controllers.currentUser)
  router.post('/logout', controllers.logout)
  return router
}

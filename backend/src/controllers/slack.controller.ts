import type { RequestHandler } from 'express'
import type { SlackService } from '../services/slack.service'
import { AppError } from '../utils/errors'

export function buildSlackControllers(service: SlackService, frontendUrl: string) {
  const connect: RequestHandler = async (req, res, next) => {
    try {
      if (!req.user) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required')
      res.redirect(302, await service.beginConnect(req.user))
    } catch (err) {
      next(err)
    }
  }

  const callback: RequestHandler = async (req, res, next) => {
    try {
      if (!req.user) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required')
      if (typeof req.query.error === 'string') {
        const state = typeof req.query.state === 'string' ? req.query.state : ''
        await service.rejectConnect(req.user, state)
        const target = new URL('/scheduled?slack=denied', frontendUrl)
        res.redirect(303, target.toString())
        return
      }
      const code = typeof req.query.code === 'string' ? req.query.code : ''
      const state = typeof req.query.state === 'string' ? req.query.state : ''
      await service.completeConnect(req.user, code, state)
      res.redirect(303, new URL('/scheduled?slack=connected', frontendUrl).toString())
    } catch (err) {
      next(err)
    }
  }

  const status: RequestHandler = async (req, res, next) => {
    try {
      if (!req.user) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required')
      res.json(await service.connectionStatus(req.user.id))
    } catch (err) {
      next(err)
    }
  }

  const disconnect: RequestHandler = async (req, res, next) => {
    try {
      if (!req.user) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required')
      await service.disconnect(req.user.id)
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  }

  return { connect, callback, status, disconnect }
}

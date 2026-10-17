import type { RequestHandler } from 'express'
import { OAUTH_STATE_COOKIE, type AuthService } from '../services/auth.service'
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from '../middleware/auth'
import { AppError } from '../utils/errors'

export function buildAuthControllers(
  service: AuthService,
  options: { frontendUrl: string; secureCookies: boolean },
) {
  const login: RequestHandler = async (req, res, next) => {
    try {
      const login = await service.beginLogin(req.header('cookie'))
      res.cookie(OAUTH_STATE_COOKIE, login.stateCookie, {
        httpOnly: true,
        secure: options.secureCookies,
        sameSite: 'lax',
        path: '/',
        maxAge: 10 * 60 * 1000,
      })
      res.redirect(302, login.redirectUrl)
    } catch (err) {
      next(err)
    }
  }

  const callback: RequestHandler = async (req, res, next) => {
    try {
      if (typeof req.query.error === 'string') {
        throw new AppError(401, 'GOOGLE_AUTH_FAILED', 'Google sign-in was not completed')
      }
      const code = typeof req.query.code === 'string' ? req.query.code : ''
      const state = typeof req.query.state === 'string' ? req.query.state : ''
      const result = await service.completeLogin(code, state, req.header('cookie'))
      res.cookie(SESSION_COOKIE, result.cookieValue, {
        httpOnly: true,
        secure: options.secureCookies,
        sameSite: options.secureCookies ? 'none' : 'lax',
        path: '/',
        maxAge: SESSION_TTL_SECONDS * 1000,
      })
      res.redirect(303, new URL('/scheduled', options.frontendUrl).toString())
    } catch (err) {
      next(err)
    }
  }

  const currentUser: RequestHandler = (req, res, next) => {
    try {
      if (!req.user) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required')
      res.json({ user: req.user })
    } catch (err) {
      next(err)
    }
  }

  const logout: RequestHandler = async (req, res, next) => {
    try {
      await service.logout(req.header('cookie'))
      res.clearCookie(SESSION_COOKIE, {
        httpOnly: true,
        secure: options.secureCookies,
        sameSite: options.secureCookies ? 'none' : 'lax',
        path: '/',
      })
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  }

  return { login, callback, currentUser, logout }
}

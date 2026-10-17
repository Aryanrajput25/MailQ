import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { RequestHandler } from 'express'
import { AppError } from '../utils/errors'

export interface AuthUser {
  id: string
  email: string
  name: string
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}

export const SESSION_COOKIE = 'reachinbox.sid'
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

type SessionValue = { user: AuthUser }

export function requestCookie(cookieHeader: string | undefined, name: string): string | null {
  return (
    cookieHeader
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? null
  )
}

export function sessionCookieValue(sessionId: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(sessionId).digest('base64url')
  return `${sessionId}.${signature}`
}

export function sessionIdFromRequest(cookieHeader: string | undefined, secret: string): string | null {
  const cookie = requestCookie(cookieHeader, SESSION_COOKIE)
  if (!cookie) return null

  const separator = cookie.lastIndexOf('.')
  if (separator < 1) return null
  const id = cookie.slice(0, separator)
  const supplied = Buffer.from(cookie.slice(separator + 1))
  const expected = Buffer.from(sessionCookieValue(id, secret).split('.').at(-1) ?? '')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null
  return /^[a-f0-9]{64}$/.test(id) ? id : null
}

export function sessionAuthentication(redis: Redis, secret: string): RequestHandler {
  return async (req, _res, next) => {
    try {
      const sessionId = sessionIdFromRequest(req.header('cookie'), secret)
      if (!sessionId) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required')
      const value = await redis.get(`session:${sessionId}`)
      if (!value) throw new AppError(401, 'UNAUTHENTICATED', 'Session expired')
      let session: SessionValue
      try {
        session = JSON.parse(value) as SessionValue
      } catch {
        throw new AppError(401, 'UNAUTHENTICATED', 'Invalid session')
      }
      if (
        typeof session.user?.id !== 'string' ||
        typeof session.user.email !== 'string' ||
        typeof session.user.name !== 'string'
      ) {
        throw new AppError(401, 'UNAUTHENTICATED', 'Invalid session')
      }
      req.user = session.user
      next()
    } catch (err) {
      next(err)
    }
  }
}

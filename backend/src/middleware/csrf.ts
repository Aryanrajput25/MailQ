import type { RequestHandler } from 'express'
import { AppError } from '../utils/errors'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function requireFrontendOrigin(frontendUrl: string): RequestHandler {
  const allowedOrigin = new URL(frontendUrl).origin
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next()
      return
    }
    const origin = req.header('origin')
    if (origin !== allowedOrigin) {
      next(new AppError(403, 'CSRF_REJECTED', 'A valid frontend Origin header is required'))
      return
    }
    next()
  }
}

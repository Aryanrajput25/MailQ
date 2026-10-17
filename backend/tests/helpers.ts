import type { PrismaClient } from '@prisma/client'
import type { RequestHandler } from 'express'
import { createApp } from '../src/app'
import type { AuthService } from '../src/services/auth.service'
import { AppError } from '../src/utils/errors'
import { SchedulingService, type SchedulingLimits } from '../src/services/scheduling.service'

export const LIMITS: SchedulingLimits = { maxRecipientsPerBatch: 1000, maxHourlyLimit: 100 }

export function testAuth(prisma: PrismaClient): RequestHandler {
  return async (req, _res, next) => {
    try {
      const email = req.header('x-test-user-email')?.trim().toLowerCase()
      if (!email) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required')
      const user = await prisma.user.upsert({
        where: { email },
        create: { email, googleSub: `test:${email}`, name: email.split('@')[0] ?? 'test' },
        update: {},
        select: { id: true, email: true, name: true },
      })
      req.user = user
      next()
    } catch (err) {
      next(err)
    }
  }
}

export function buildTestApp(prisma: PrismaClient, limits: Partial<SchedulingLimits> = {}, clock?: () => number) {
  return createApp({
    config: { FRONTEND_URL: 'http://localhost:3000', isProduction: false },
    prisma,
    health: {
      prisma: { $queryRaw: (async () => [1]) as never },
      redis: { ping: async () => 'PONG' },
      elasticsearchUrl: 'http://es.invalid:9200',
      fetchImpl: (async () => new Response('{}')) as never,
    },
    authenticate: testAuth(prisma),
    scheduling: new SchedulingService(prisma, { ...LIMITS, ...limits }, clock),
    auth: {} as AuthService,
  })
}

export const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

export const validBody = (over: Record<string, unknown> = {}) => ({
  from: 'sender@example.com',
  to: ['a@example.com'],
  subject: 'Hello',
  bodyHtml: '<p>Hi there</p>',
  ...over,
})

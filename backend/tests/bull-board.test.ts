import { Queue, type Job } from 'bullmq'
import type { PrismaClient } from '@prisma/client'
import type { RequestHandler } from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import type { EmailJobData } from '../src/queues/email.queue'
import type { AuthService } from '../src/services/auth.service'
import { AppError } from '../src/utils/errors'

const origin = 'http://localhost:3000'
const admin = { id: 'user-admin', email: 'admin@example.com', name: 'Admin' }
const statuses = ['wait', 'active', 'delayed', 'completed', 'failed', 'paused', 'waiting-children']
const queueCounts = Object.fromEntries(statuses.map((status) => [status, 1]))
let queue: Queue<EmailJobData> | undefined

function makeQueue(): Queue<EmailJobData> {
  const instance = new Queue<EmailJobData>('email-delivery', {
    connection: { host: '127.0.0.1', port: 6379, lazyConnect: true },
  })
  vi.spyOn(instance, 'getJobCounts').mockResolvedValue(queueCounts)
  vi.spyOn(instance, 'isPaused').mockResolvedValue(false)
  vi.spyOn(instance, 'getGlobalConcurrency').mockResolvedValue(null)
  vi.spyOn(instance, 'getRateLimitTtl').mockResolvedValue(-2)
  vi.spyOn(instance, 'getJobSchedulersCount').mockResolvedValue(0)
  vi.spyOn(instance, 'getJobs').mockResolvedValue([])
  vi.spyOn(instance, 'getJob').mockResolvedValue({
    getState: async () => 'failed',
    toJSON: () => ({
      id: 'email_eml_1',
      name: 'deliver-email',
      data: { emailId: 'eml_1' },
      failedReason: 'SMTP connection refused',
      stacktrace: ['SMTP connection refused'],
      attemptsMade: 2,
      timestamp: 1,
      processedOn: 2,
      finishedOn: 3,
      progress: 0,
      delay: 0,
      opts: {},
      returnvalue: null,
    }),
  } as unknown as Job<EmailJobData>)
  vi.spyOn(instance, 'close').mockResolvedValue()
  queue = instance
  return instance
}

function makeApp(options: {
  user?: typeof admin | null
  adminEmails?: string[]
  withQueue?: boolean
} = {}) {
  const user = options.user === undefined ? admin : options.user
  const authenticate: RequestHandler = (req, _res, next) => {
    if (!user) {
      next(new AppError(401, 'UNAUTHENTICATED', 'Authentication required'))
      return
    }
    req.user = user
    next()
  }
  return createApp({
    config: { FRONTEND_URL: origin, isProduction: false },
    prisma: {} as PrismaClient,
    health: {
      prisma: {} as never,
      redis: { ping: async () => 'PONG' },
      elasticsearchUrl: 'http://es.invalid',
    },
    authenticate,
    scheduling: { schedule: async () => { throw new Error('unused') } },
    auth: {} as AuthService,
    bullBoardQueue: options.withQueue === false ? undefined : makeQueue(),
    bullBoardAdminEmails: options.adminEmails ?? ['admin@example.com'],
  })
}

afterEach(async () => {
  if (queue) {
    await queue.close()
    queue = undefined
  }
})

describe('secure Bull Board queue monitoring', () => {
  it('mounts the existing email delivery queue read-only and exposes supported job states', async () => {
    const app = makeApp()
    const page = await request(app).get('/admin/queues/')
    expect(page.status).toBe(200)
    expect(page.text).toContain('ReachInbox Queue Monitor')

    const response = await request(app).get('/admin/queues/api/queues?activeQueue=email-delivery')
    expect(response.status).toBe(200)
    expect(response.body.queues).toHaveLength(1)
    expect(response.body.queues[0]).toMatchObject({
      name: 'email-delivery',
      readOnlyMode: true,
      counts: queueCounts,
      statuses: expect.arrayContaining(['active', 'delayed', 'completed', 'failed']),
    })
    expect(queue?.name).toBe('email-delivery')

    const detail = await request(app).get('/admin/queues/api/queues/email-delivery/email_eml_1')
    expect(detail.status).toBe(200)
    expect(detail.body.status).toBe('failed')
    expect(detail.body.job.failedReason).toBe('SMTP connection refused')
    expect(detail.body.job.data).toEqual({ emailId: 'eml_1' })
  })

  it('requires a verified session and rejects authenticated users outside the configured allowlist', async () => {
    const unauthenticated = await request(makeApp({ user: null })).get('/admin/queues/')
    expect(unauthenticated.status).toBe(401)

    const viewer = await request(makeApp({
      user: { id: 'user-viewer', email: 'viewer@example.com', name: 'Viewer' },
    })).get('/admin/queues/')
    expect(viewer.status).toBe(403)
    expect(viewer.body.error.code).toBe('ADMIN_REQUIRED')
  })

  it('does not mount the dashboard when administrator configuration is missing', async () => {
    const response = await request(makeApp({ adminEmails: [] })).get('/admin/queues/')
    expect(response.status).toBe(404)
  })

  it('keeps the dashboard unavailable if the queue instance is not wired', async () => {
    const response = await request(makeApp({ withQueue: false })).get('/admin/queues/')
    expect(response.status).toBe(404)
  })
})

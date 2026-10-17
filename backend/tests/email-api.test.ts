import type { PrismaClient } from '@prisma/client'
import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import type { AuthService } from '../src/services/auth.service'
import type { EmailSearchService } from '../src/services/email-search.service'

const ownerId = 'owner-1'
const origin = 'http://localhost:3000'

function makeApp(
  email: Record<string, unknown>,
  queue = { remove: vi.fn(async () => true) },
  emailSearch?: EmailSearchService,
) {
  const prisma = { email } as never
  const authenticate: RequestHandler = (req, _res, next) => {
    req.user = { id: ownerId, email: 'owner@example.com', name: 'Owner' }
    next()
  }
  const app = createApp({
    config: { FRONTEND_URL: origin, isProduction: false },
    prisma: prisma as PrismaClient,
    health: { prisma: {} as never, redis: { ping: async () => 'PONG' }, elasticsearchUrl: 'http://es.invalid' },
    authenticate,
    scheduling: { schedule: async () => { throw new Error('unused') } },
    auth: {} as AuthService,
    emailQueue: queue,
    emailSearch,
  })
  return { app, queue }
}

describe('email read and cancellation APIs', () => {
  it('lists only the authenticated owner with validated filters and pagination', async () => {
    const findMany = vi.fn(async () => [{ id: 'eml_1', status: 'scheduled' }])
    const count = vi.fn(async () => 3)
    const { app } = makeApp({ findMany, count })
    const res = await request(app).get('/api/emails').query({
      folder: 'scheduled',
      search: 'launch',
      starred: 'true',
      page: '2',
      pageSize: '10',
      sort: 'createdAt',
      order: 'asc',
    })

    expect(res.status).toBe(200)
    expect(res.body.pagination).toEqual({ page: 2, pageSize: 10, total: 3, pageCount: 1 })
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerId,
          AND: [{ status: { in: ['scheduled', 'processing'] } }],
          starred: true,
          OR: expect.arrayContaining([expect.objectContaining({ subject: expect.any(Object) })]),
        }),
        skip: 10,
        take: 10,
        orderBy: [{ createdAt: 'asc' }, { id: 'desc' }],
      }),
    )
  })

  it('returns owner-scoped counts', async () => {
    const groupBy = vi.fn(async () => [
      { status: 'scheduled', _count: { _all: 2 } },
      { status: 'processing', _count: { _all: 1 } },
      { status: 'sent', _count: { _all: 4 } },
    ])
    const { app } = makeApp({ groupBy })
    const res = await request(app).get('/api/emails/counts')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ scheduled: 2, processing: 1, sent: 4, pending: 3, total: 7 })
    expect(groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId } }))
  })

  it('searches Elasticsearch with the session owner and hydrates only matching owned rows', async () => {
    const search = vi.fn(async () => ({ ids: ['email-a', 'email-b'], total: 12 }))
    const findMany = vi.fn(async () => [{ id: 'email-b', ownerId }, { id: 'email-a', ownerId }])
    const { app } = makeApp(
      { findMany, count: vi.fn() },
      { remove: vi.fn(async () => true) },
      { search } as unknown as EmailSearchService,
    )
    const res = await request(app).get('/api/emails/search').query({
      search: 'launch',
      folder: 'scheduled',
      starred: 'true',
      page: '2',
      pageSize: '10',
      sort: 'subject',
      order: 'asc',
      ownerId: 'attacker-controlled',
    })
    expect(res.status).toBe(200)
    expect(search).toHaveBeenCalledWith({
      ownerId,
      query: 'launch',
      statuses: ['scheduled', 'processing'],
      from: 10,
      size: 10,
      sort: 'subject',
      order: 'asc',
      starred: true,
    })
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: { in: ['email-a', 'email-b'] },
        ownerId,
        AND: [{ status: { in: ['scheduled', 'processing'] } }],
        starred: true,
      },
    }))
    expect(res.body.items.map((item: { id: string }) => item.id)).toEqual(['email-a', 'email-b'])
    expect(res.body.searchSource).toBe('elasticsearch')
  })

  it('falls back to authenticated PostgreSQL search when Elasticsearch is unavailable', async () => {
    const findMany = vi.fn(async () => [{ id: 'email-a' }])
    const count = vi.fn(async () => 1)
    const search = vi.fn(async () => { throw new Error('Elasticsearch timeout') })
    const { app } = makeApp(
      { findMany, count },
      { remove: vi.fn(async () => true) },
      { search } as unknown as EmailSearchService,
    )
    const res = await request(app).get('/api/emails').query({ search: 'sender@example.com' })
    expect(res.status).toBe(200)
    expect(res.body.searchSource).toBe('postgres-fallback')
    expect(count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        ownerId,
        OR: expect.arrayContaining([
          expect.objectContaining({ subject: { contains: 'sender@example.com', mode: 'insensitive' } }),
          expect.objectContaining({ sender: { is: { email: { contains: 'sender@example.com', mode: 'insensitive' } } } }),
        ]),
      }),
    }))
  })

  it('validates search pagination and sort inputs before querying Elasticsearch', async () => {
    const search = vi.fn()
    const { app } = makeApp(
      {},
      { remove: vi.fn(async () => true) },
      { search } as unknown as EmailSearchService,
    )
    const res = await request(app).get('/api/emails/search').query({ search: 'mail', pageSize: '1000', sort: 'secretField' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(search).not.toHaveBeenCalled()
  })

  it("does not reveal another user's email and rejects malformed IDs", async () => {
    const findFirst = vi.fn(async () => null)
    const { app } = makeApp({ findFirst })
    const missing = await request(app).get('/api/emails/eml_foreign')
    expect(missing.status).toBe(404)
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'eml_foreign', ownerId } }))

    const malformed = await request(app).get('/api/emails/not.valid')
    expect(malformed.status).toBe(400)
  })

  it('cancels only a scheduled email and removes its queued job', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const findFirst = vi.fn(async () => ({ id: 'eml_1', jobId: 'email_eml_1', status: 'cancelled' }))
    const { app, queue } = makeApp({ updateMany, findFirst })
    const res = await request(app)
      .post('/api/emails/eml_1/cancel')
      .set('Origin', origin)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: 'eml_1', status: 'cancelled', queueCleanupPending: false })
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'eml_1', ownerId, status: 'scheduled' },
      data: { status: 'cancelled' },
    })
    expect(queue.remove).toHaveBeenCalledWith('email_eml_1')
  })

  it('reports cross-user cancellation as not found', async () => {
    const { app } = makeApp({
      updateMany: vi.fn(async () => ({ count: 0 })),
      findFirst: vi.fn(async () => null),
    })
    const res = await request(app)
      .post('/api/emails/eml_foreign/cancel')
      .set('Origin', origin)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('EMAIL_NOT_FOUND')
  })

  it('reports active queue cleanup for the worker to skip safely', async () => {
    const queue = { remove: vi.fn(async () => false) }
    const { app } = makeApp({
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => ({ id: 'eml_1', jobId: 'email_eml_1', status: 'cancelled' })),
    }, queue)
    const res = await request(app)
      .post('/api/emails/eml_1/cancel')
      .set('Origin', origin)
    expect(res.status).toBe(200)
    expect(res.body.queueCleanupPending).toBe(true)
  })
})

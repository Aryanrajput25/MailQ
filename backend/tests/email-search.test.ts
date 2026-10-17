import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { EMAIL_SEARCH_INDEX, EmailSearchService } from '../src/services/email-search.service'

function response(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function emailRecord(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    ownerId: 'owner-1',
    status: 'scheduled',
    subject: 'Hello',
    bodyText: 'A searchable message',
    recipientEmail: 'recipient@example.com',
    recipientName: 'Recipient',
    scheduledAt: new Date('2026-10-20T10:00:00Z'),
    sentAt: null,
    createdAt: new Date('2026-10-17T10:00:00Z'),
    starred: false,
    sender: { email: 'sender@example.com', displayName: 'Sender' },
    ...over,
  }
}

describe('EmailSearchService', () => {
  it('creates the versioned index with an explicit mapping and handles create races', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), init })
      if (init?.method === 'HEAD') return response({}, 404)
      if (init?.method === 'PUT') {
        return new Response(JSON.stringify({ error: { type: 'resource_already_exists_exception' } }), { status: 400 })
      }
      return response()
    })
    const service = new EmailSearchService({} as never, 'http://es.example:9200', 'search-key', fetchImpl)

    await expect(service.ensureIndex()).resolves.toBeUndefined()
    expect(calls[0]?.url).toBe(`http://es.example:9200/${EMAIL_SEARCH_INDEX}`)
    expect(calls[0]?.init?.method).toBe('HEAD')
    expect(calls[1]?.init?.method).toBe('PUT')
    expect(new Headers(calls[1]?.init?.headers).get('authorization')).toBe('ApiKey search-key')
    const mapping = JSON.parse(String(calls[1]?.init?.body))
    expect(mapping.mappings.dynamic).toBe('strict')
    expect(mapping.mappings.properties).toMatchObject({
      id: { type: 'keyword' },
      ownerId: { type: 'keyword' },
      status: { type: 'keyword' },
      subject: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      bodyText: { type: 'text' },
      recipientEmail: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      senderEmail: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      scheduledAt: { type: 'date' },
    })
  })

  it('indexes and updates documents idempotently, removes deletes and clears only current outbox events', async () => {
    const row = emailRecord('email-1')
    const events = [
      { emailId: 'email-1', operation: 'upsert', updatedAt: new Date('2026-10-17T12:00:00Z'), attemptCount: 0 },
      { emailId: 'email-1', operation: 'upsert', updatedAt: new Date('2026-10-17T12:01:00Z'), attemptCount: 0 },
      { emailId: 'email-2', operation: 'delete', updatedAt: new Date('2026-10-17T12:02:00Z'), attemptCount: 0 },
    ]
    const findMany = vi.fn(async () => events.splice(0))
    const deleteMany = vi.fn(async () => ({ count: 1 }))
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) =>
      init?.method === 'HEAD' ? response({}, 200) : response(),
    )
    const service = new EmailSearchService(
      {
        emailSearchOutbox: { findMany, deleteMany },
        email: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => where.id === row.id ? row : null) },
      } as never,
      'http://es.example:9200',
      undefined,
      fetchImpl,
    )

    const result = await service.reconcile(10, new Date('2026-10-17T12:03:00Z'))
    expect(result).toEqual({ indexed: 3, failed: 0 })
    const puts = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PUT')
    expect(puts).toHaveLength(2)
    const document = JSON.parse(String(puts[0]?.[1]?.body))
    expect(document).toEqual({
      id: 'email-1',
      ownerId: 'owner-1',
      status: 'scheduled',
      subject: 'Hello',
      bodyText: 'A searchable message',
      recipientEmail: 'recipient@example.com',
      recipientName: 'Recipient',
      senderEmail: 'sender@example.com',
      senderName: 'Sender',
      scheduledAt: '2026-10-20T10:00:00.000Z',
      sentAt: null,
      createdAt: '2026-10-17T10:00:00.000Z',
      starred: false,
    })
    expect(JSON.stringify(document)).not.toMatch(/token|secret|smtpPass|session/i)
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    expect(deleteMany).toHaveBeenCalledTimes(3)
  })

  it('indexes sent, failed and cancelled status updates from authoritative email rows', async () => {
    const statuses = ['sent', 'failed', 'cancelled'] as const
    const events = statuses.map((status, index) => ({
      emailId: `email-${index}`,
      operation: 'upsert',
      updatedAt: new Date(`2026-10-17T12:0${index}:00Z`),
      attemptCount: 0,
    }))
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) =>
      init?.method === 'HEAD' ? response({}, 200) : response(),
    )
    const service = new EmailSearchService(
      {
        emailSearchOutbox: {
          findMany: vi.fn(async () => events),
          deleteMany: vi.fn(async () => ({ count: 1 })),
        },
        email: {
          findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
            const index = Number(where.id.split('-')[1])
            return emailRecord(where.id, { status: statuses[index] })
          }),
        },
      } as never,
      'http://es.example:9200',
      undefined,
      fetchImpl,
    )
    expect(await service.reconcile()).toEqual({ indexed: 3, failed: 0 })
    const docs = fetchImpl.mock.calls
      .filter(([, init]) => init?.method === 'PUT')
      .map(([, init]) => JSON.parse(String(init?.body)) as { status: string })
    expect(docs.map((doc) => doc.status)).toEqual(statuses)
  })

  it('retries failed indexing durably and succeeds during reconciliation', async () => {
    const event = {
      emailId: 'email-1',
      operation: 'upsert',
      updatedAt: new Date('2026-10-17T12:00:00Z'),
      attemptCount: 0,
    }
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({}, 200))
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(response())
    const deleteMany = vi.fn(async () => ({ count: 1 }))
    const service = new EmailSearchService(
      {
        emailSearchOutbox: {
          findMany: vi.fn(async () => [event]),
          updateMany,
          deleteMany,
        },
        email: { findUnique: vi.fn(async () => emailRecord(event.emailId)) },
      } as never,
      'http://es.example:9200',
      undefined,
      fetchImpl,
    )

    const failed = await service.reconcile(10, new Date('2026-10-17T12:00:00Z'))
    expect(failed).toEqual({ indexed: 0, failed: 1 })
    expect(updateMany).toHaveBeenCalledWith({
      where: { emailId: event.emailId, updatedAt: event.updatedAt },
      data: {
        attemptCount: { increment: 1 },
        nextAttemptAt: new Date('2026-10-17T12:00:01Z'),
        lastError: 'Elasticsearch is unavailable or timed out',
      },
    })
    expect(await service.reconcile(10, new Date('2026-10-17T12:00:02Z'))).toEqual({ indexed: 1, failed: 0 })
    expect(deleteMany).toHaveBeenCalledWith({ where: { emailId: event.emailId, updatedAt: event.updatedAt } })
  })

  it('uses owner filter, relevant fields, deterministic pagination and validates Elasticsearch results', async () => {
    const bodies: unknown[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'HEAD') return response({}, 200)
      bodies.push(JSON.parse(String(init?.body)))
      return response({ hits: { total: { value: 31 }, hits: [{ _id: 'email-a' }, { _id: 'email-b' }] } })
    })
    const service = new EmailSearchService({} as never, 'http://es.example:9200', undefined, fetchImpl)

    const result = await service.search({
      ownerId: 'owner-1',
      query: 'hello',
      statuses: ['sent'],
      starred: true,
      from: 20,
      size: 10,
      sort: 'subject',
      order: 'asc',
    })
    expect(result).toEqual({ ids: ['email-a', 'email-b'], total: 31 })
    expect(bodies[0]).toMatchObject({
      from: 20,
      size: 10,
      track_total_hits: true,
      query: {
        bool: {
          filter: [
            { term: { ownerId: 'owner-1' } },
            { terms: { status: ['sent'] } },
            { term: { starred: true } },
          ],
          must: [{ multi_match: { query: 'hello', fields: expect.arrayContaining(['subject^4', 'senderEmail^3', 'bodyText']) } }],
        },
      },
      sort: [
        { 'subject.keyword': { order: 'asc', unmapped_type: 'keyword', missing: '_last' } },
        { id: 'desc' },
      ],
    })
  })

  it('reindexes PostgreSQL records in stable keyset batches', async () => {
    const rows = [emailRecord('email-a'), emailRecord('email-b')]
    const findMany = vi.fn(async (args: { cursor?: { id: string }; take: number }) => {
      if (args.cursor?.id === 'email-a') return rows.slice(1, 2)
      if (args.cursor) return []
      return rows.slice(0, args.take)
    })
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) =>
      init?.method === 'HEAD' ? response({}, 200) : response(),
    )
    const service = new EmailSearchService(
      { email: { findMany } } as never,
      'http://es.example:9200',
      undefined,
      fetchImpl,
    )
    expect(await service.reindexAll(1)).toEqual({ indexed: 2, failed: 0 })
    expect(findMany).toHaveBeenCalledTimes(3)
    expect(findMany.mock.calls[1]?.[0]).toMatchObject({ cursor: { id: 'email-a' }, skip: 1, take: 1 })
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2)
  })

})

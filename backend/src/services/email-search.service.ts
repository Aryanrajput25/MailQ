import type { Prisma, PrismaClient } from '@prisma/client'
import type { Config } from '../config/env'
import { logger } from '../utils/logger'

export const EMAIL_SEARCH_INDEX = 'reachinbox-emails-v1'
const REQUEST_TIMEOUT_MS = 5000
const MAX_RETRY_DELAY_MS = 5 * 60_000

export interface EmailSearchQuery {
  ownerId: string
  query: string
  statuses?: string[]
  from: number
  size: number
  sort: 'createdAt' | 'scheduledAt' | 'sentAt' | 'subject'
  order: 'asc' | 'desc'
  starred?: boolean
}

export interface EmailSearchPage {
  ids: string[]
  total: number
}

type IndexDocument = {
  id: string
  ownerId: string
  status: string
  subject: string
  bodyText: string
  recipientEmail: string
  recipientName: string | null
  senderEmail: string
  senderName: string | null
  scheduledAt: string
  sentAt: string | null
  createdAt: string
  starred: boolean
}

type SearchHit = { _id?: unknown }
type SearchResponse = { hits?: { total?: number | { value?: number }; hits?: SearchHit[] } }

type EmailSearchPrisma = Pick<PrismaClient, 'emailSearchOutbox' | 'email'> & Pick<PrismaClient, '$queryRaw'>

export class EmailSearchService {
  private indexReady?: Promise<void>
  private indexCreated = false

  constructor(
    private readonly prisma: EmailSearchPrisma,
    private readonly elasticsearchUrl: string,
    private readonly apiKey?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async ensureIndex(): Promise<void> {
    if (!this.indexReady) {
      this.indexReady = this.createIndex().catch((err) => {
        this.indexReady = undefined
        throw err
      })
    }
    return this.indexReady
  }

  async search(query: EmailSearchQuery): Promise<EmailSearchPage> {
    await this.ensureIndex()
    await this.bootstrapNewIndex()
    const filters: Record<string, unknown>[] = [{ term: { ownerId: query.ownerId } }]
    if (query.statuses?.length) filters.push({ terms: { status: query.statuses } })
    if (query.starred !== undefined) filters.push({ term: { starred: query.starred } })
    const sortField = query.sort === 'subject' ? 'subject.keyword' : query.sort
    const response = await this.request(`${this.indexPath()}/_search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: query.from,
        size: query.size,
        track_total_hits: true,
        query: {
          bool: {
            filter: filters,
            must: [
              {
                multi_match: {
                  query: query.query,
                  type: 'best_fields',
                  operator: 'and',
                  fields: [
                    'subject^4',
                    'recipientEmail^3',
                    'recipientName^2',
                    'senderEmail^3',
                    'senderName^2',
                    'bodyText',
                    'status',
                  ],
                },
              },
            ],
          },
        },
        sort: [{ [sortField]: { order: query.order, unmapped_type: sortField === 'subject.keyword' ? 'keyword' : 'date', missing: '_last' } }, { id: 'desc' }],
      }),
    })
    const result = await response.json() as SearchResponse
    const rawTotal = result.hits?.total
    const total = typeof rawTotal === 'number' ? rawTotal : rawTotal?.value
    if (!Number.isSafeInteger(total) || total! < 0 || !Array.isArray(result.hits?.hits)) {
      throw new Error('Elasticsearch returned an invalid search response')
    }
    const ids = result.hits!.hits!.map((hit) => hit._id)
    if (!ids.every((id): id is string => typeof id === 'string')) {
      throw new Error('Elasticsearch returned an invalid email document ID')
    }
    return { ids, total: total! }
  }

  async reconcile(limit = 500, now = new Date()): Promise<{ indexed: number; failed: number }> {
    await this.ensureIndex()
    await this.bootstrapNewIndex()
    const events = await this.prisma.emailSearchOutbox.findMany({
      where: { nextAttemptAt: { lte: now } },
      orderBy: [{ createdAt: 'asc' }, { emailId: 'asc' }],
      take: limit,
      select: { emailId: true, operation: true, updatedAt: true, attemptCount: true },
    })
    let indexed = 0
    let failed = 0
    for (const event of events) {
      try {
        await this.syncEmail(event.emailId, event.operation)
        const removed = await this.prisma.emailSearchOutbox.deleteMany({
          where: { emailId: event.emailId, updatedAt: event.updatedAt },
        })
        indexed += removed.count
      } catch (err) {
        const attemptCount = event.attemptCount + 1
        const retryDelay = Math.min(1000 * 2 ** Math.min(attemptCount - 1, 8), MAX_RETRY_DELAY_MS)
        await this.prisma.emailSearchOutbox.updateMany({
          where: { emailId: event.emailId, updatedAt: event.updatedAt },
          data: {
            attemptCount: { increment: 1 },
            nextAttemptAt: new Date(now.getTime() + retryDelay),
            lastError: err instanceof Error ? err.message.slice(0, 1000) : 'Elasticsearch synchronization failed',
          },
        })
        failed++
        logger.warn({ emailId: event.emailId, attemptCount, err }, 'email search indexing failed; durable outbox will retry')
      }
    }
    return { indexed, failed }
  }

  async reindexAll(batchSize = 500): Promise<{ indexed: number; failed: number }> {
    await this.ensureIndex()
    const result = await this.reindexRows(batchSize)
    this.indexCreated = false
    return result
  }

  private async bootstrapNewIndex(): Promise<void> {
    if (!this.indexCreated) return
    const result = await this.reindexRows()
    this.indexCreated = false
    if (result.failed > 0) throw new Error('Initial Elasticsearch index population was incomplete; durable outbox retries are pending')
  }

  private async reindexRows(batchSize = 500): Promise<{ indexed: number; failed: number }> {
    let cursor: string | undefined
    let indexed = 0
    let failed = 0
    for (;;) {
      const emails = await this.prisma.email.findMany({
        take: batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        include: { sender: { select: { email: true, displayName: true } } },
      })
      if (emails.length === 0) break
      for (const email of emails) {
        try {
          await this.indexDocument(projectEmail(email))
          indexed++
        } catch (err) {
          failed++
          logger.warn({ emailId: email.id, err }, 'email could not be reindexed; durable outbox will retry')
          await this.prisma.emailSearchOutbox.upsert({
            where: { emailId: email.id },
            create: { emailId: email.id, operation: 'upsert', nextAttemptAt: new Date() },
            update: { operation: 'upsert', attemptCount: 0, nextAttemptAt: new Date(), lastError: null },
          })
        }
      }
      cursor = emails.at(-1)!.id
      if (emails.length < batchSize) break
    }
    return { indexed, failed }
  }

  private async syncEmail(emailId: string, operation: string): Promise<void> {
    if (operation === 'delete') {
      await this.deleteDocument(emailId)
      return
    }
    const email = await this.prisma.email.findUnique({
      where: { id: emailId },
      include: { sender: { select: { email: true, displayName: true } } },
    })
    if (!email) {
      await this.deleteDocument(emailId)
      return
    }
    await this.indexDocument(projectEmail(email))
  }

  private async createIndex(): Promise<void> {
    const head = await this.request(this.indexPath(), { method: 'HEAD', allowNotFound: true })
    if (head.status !== 404) return
    const response = await this.request(this.indexPath(), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        settings: { number_of_shards: 1, number_of_replicas: 0 },
        mappings: {
          dynamic: 'strict',
          properties: {
            id: { type: 'keyword' },
            ownerId: { type: 'keyword' },
            status: { type: 'keyword' },
            subject: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
            bodyText: { type: 'text' },
            recipientEmail: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 320 } } },
            recipientName: { type: 'text' },
            senderEmail: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 320 } } },
            senderName: { type: 'text' },
            scheduledAt: { type: 'date' },
            sentAt: { type: 'date' },
            createdAt: { type: 'date' },
            starred: { type: 'boolean' },
          },
        },
      }),
      acceptAlreadyExists: true,
    })
    if (!response.ok && response.status !== 400) throw new Error(`Could not create Elasticsearch index (HTTP ${response.status})`)
    if (response.status !== 400) this.indexCreated = true
  }

  private async indexDocument(document: IndexDocument): Promise<void> {
    await this.ensureIndex()
    await this.request(`${this.indexPath()}/_doc/${encodeURIComponent(document.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(document),
    })
  }

  private async deleteDocument(emailId: string): Promise<void> {
    await this.ensureIndex()
    await this.request(`${this.indexPath()}/_doc/${encodeURIComponent(emailId)}`, {
      method: 'DELETE',
      allowNotFound: true,
    })
  }

  private indexPath(): string {
    return `/${EMAIL_SEARCH_INDEX}`
  }

  private async request(
    path: string,
    init: RequestInit & { allowNotFound?: boolean; acceptAlreadyExists?: boolean },
  ): Promise<Response> {
    const { allowNotFound, acceptAlreadyExists, ...requestInit } = init
    let response: Response
    try {
      const headers = new Headers(requestInit.headers)
      if (this.apiKey) headers.set('authorization', `ApiKey ${this.apiKey}`)
      response = await this.fetchImpl(`${this.elasticsearchUrl.replace(/\/$/, '')}${path}`, {
        ...requestInit,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new Error('Elasticsearch is unavailable or timed out')
    }
    if (response.status === 404) {
      const body = await response.clone().json().catch(() => null) as { error?: { type?: string } } | null
      if (body?.error?.type === 'index_not_found_exception' || path === `${this.indexPath()}/_search`) {
        this.indexReady = undefined
        throw new Error('Elasticsearch index is missing and will be recreated')
      }
      if (allowNotFound) return response
    }
    if (acceptAlreadyExists && response.status === 400) {
      const body = await response.json().catch(() => null) as { error?: { type?: string } } | null
      if (body?.error?.type === 'resource_already_exists_exception') return response
    }
    if (!response.ok) throw new Error(`Elasticsearch request failed (HTTP ${response.status})`)
    return response
  }
}

function projectEmail(email: Prisma.EmailGetPayload<{ include: { sender: { select: { email: true; displayName: true } } } }>): IndexDocument {
  return {
    id: email.id,
    ownerId: email.ownerId,
    status: email.status,
    subject: email.subject,
    bodyText: email.bodyText,
    recipientEmail: email.recipientEmail,
    recipientName: email.recipientName,
    senderEmail: email.sender.email,
    senderName: email.sender.displayName,
    scheduledAt: email.scheduledAt.toISOString(),
    sentAt: email.sentAt?.toISOString() ?? null,
    createdAt: email.createdAt.toISOString(),
    starred: email.starred,
  }
}

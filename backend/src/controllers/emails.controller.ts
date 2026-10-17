import type { Prisma, PrismaClient } from '@prisma/client'
import type { RequestHandler } from 'express'
import type { EmailQueuePort } from '../queues/email.queue'
import { AppError } from '../utils/errors'
import { logger } from '../utils/logger'
import { z } from 'zod'
import type { EmailSearchService } from '../services/email-search.service'

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['scheduledAt', 'createdAt', 'sentAt', 'subject']).default('scheduledAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  folder: z.enum(['all', 'scheduled', 'sent']).default('all'),
  status: z.enum(['scheduled', 'processing', 'sent', 'failed', 'cancelled']).optional(),
  search: z.string().trim().max(200).default(''),
  starred: z.enum(['true', 'false']).optional(),
}).superRefine((query, ctx) => {
  if ((query.page - 1) * query.pageSize + query.pageSize > 10_000) {
    ctx.addIssue({
      code: 'custom',
      path: ['page'],
      message: 'Requested page exceeds the maximum 10,000-result search window',
    })
  }
})

const emailIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
const starredSchema = z.object({ starred: z.boolean() })

function databaseSearchPredicates(search: string): Prisma.EmailWhereInput[] {
  const predicates: Prisma.EmailWhereInput[] = [
    { subject: { contains: search, mode: 'insensitive' } },
    { recipientEmail: { contains: search, mode: 'insensitive' } },
    { recipientName: { contains: search, mode: 'insensitive' } },
    { bodyText: { contains: search, mode: 'insensitive' } },
    { sender: { is: { email: { contains: search, mode: 'insensitive' } } } },
    { sender: { is: { displayName: { contains: search, mode: 'insensitive' } } } },
  ]
  const status = (['scheduled', 'processing', 'sent', 'failed', 'cancelled'] as const).find(
    (value) => value === search.toLowerCase(),
  )
  if (status) predicates.push({ status })
  return predicates
}

function statusesForFolder(
  folder: 'all' | 'scheduled' | 'sent',
  status?: 'scheduled' | 'processing' | 'sent' | 'failed' | 'cancelled',
): string[] | undefined {
  const folderStatuses =
    folder === 'scheduled'
      ? ['scheduled', 'processing']
      : folder === 'sent'
        ? ['sent']
        : undefined
  if (status && folderStatuses && !folderStatuses.includes(status)) return ['__no_matching_status__']
  if (status) return [status]
  return folderStatuses
}

export function buildEmailControllers(deps: {
  prisma: PrismaClient
  queue?: Pick<EmailQueuePort, 'remove'>
  emailSearch?: EmailSearchService
}) {
  const list: RequestHandler = async (req, res, next) => {
    try {
      const userId = req.user?.id
      if (!userId) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required')
      const query = listQuerySchema.parse(req.query)
      const where: Prisma.EmailWhereInput = { ownerId: userId }

      const statusConditions: Prisma.EmailWhereInput[] = []
      if (query.folder === 'scheduled') statusConditions.push({ status: { in: ['scheduled', 'processing'] } })
      if (query.folder === 'sent') statusConditions.push({ status: 'sent' })
      if (query.status) statusConditions.push({ status: query.status })
      if (statusConditions.length) where.AND = statusConditions
      if (query.starred !== undefined) where.starred = query.starred === 'true'
      if (query.search) where.OR = databaseSearchPredicates(query.search)

      if (query.search && deps.emailSearch) {
        try {
          const page = await deps.emailSearch.search({
            ownerId: userId,
            query: query.search,
            statuses: statusesForFolder(query.folder, query.status),
            from: (query.page - 1) * query.pageSize,
            size: query.pageSize,
            sort: query.sort,
            order: query.order,
            ...(query.starred === undefined ? {} : { starred: query.starred === 'true' }),
          })
          const items = page.ids.length
            ? await deps.prisma.email.findMany({
                where: {
                  id: { in: page.ids },
                  ownerId: userId,
                  ...(statusConditions.length ? { AND: statusConditions } : {}),
                  ...(query.starred === undefined ? {} : { starred: query.starred === 'true' }),
                },
                include: { sender: { select: { id: true, email: true, displayName: true } } },
              })
            : []
          const byId = new Map(items.map((item) => [item.id, item]))
          const authorizedItems = page.ids.flatMap((id) => {
            const item = byId.get(id)
            return item ? [item] : []
          })
          res.json({
            items: authorizedItems,
            pagination: {
              page: query.page,
              pageSize: query.pageSize,
              total: page.total,
              pageCount: Math.ceil(page.total / query.pageSize),
            },
            searchSource: 'elasticsearch',
          })
          return
        } catch (err) {
          logger.warn({ err, ownerId: userId }, 'Elasticsearch search unavailable; falling back to PostgreSQL')
        }
      }

      const [total, items] = await Promise.all([
        deps.prisma.email.count({ where }),
        deps.prisma.email.findMany({
          where,
          orderBy: [{ [query.sort]: query.order }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          include: { sender: { select: { id: true, email: true, displayName: true } } },
        }),
      ])
      res.json({
        items,
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          pageCount: Math.ceil(total / query.pageSize),
        },
        ...(query.search && deps.emailSearch ? { searchSource: 'postgres-fallback' } : {}),
      })
    } catch (err) {
      next(err)
    }

  }

  const detail: RequestHandler = async (req, res, next) => {
    try {
      const userId = req.user?.id
      if (!userId) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required')
      const id = emailIdSchema.parse(req.params.id)
      const email = await deps.prisma.email.findFirst({
        where: { id, ownerId: userId },
        include: { sender: { select: { id: true, email: true, displayName: true } } },
      })
      if (!email) throw new AppError(404, 'EMAIL_NOT_FOUND', 'Email not found')
      res.json({ email })
    } catch (err) {
      next(err)
    }
  }

  const counts: RequestHandler = async (req, res, next) => {
    try {
      const userId = req.user?.id
      if (!userId) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required')
      const groups = await deps.prisma.email.groupBy({
        by: ['status'],
        where: { ownerId: userId },
        _count: { _all: true },
      })
      const counts = { scheduled: 0, processing: 0, sent: 0, failed: 0, cancelled: 0 }
      for (const group of groups) counts[group.status] = group._count._all
      res.json({
        ...counts,
        pending: counts.scheduled + counts.processing,
        total: Object.values(counts).reduce((sum, value) => sum + value, 0),
      })
    } catch (err) {
      next(err)
    }
  }

  const cancel: RequestHandler = async (req, res, next) => {
    try {
      const userId = req.user?.id
      if (!userId) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required')
      const id = emailIdSchema.parse(req.params.id)
      const updated = await deps.prisma.email.updateMany({
        where: { id, ownerId: userId, status: 'scheduled' },
        data: { status: 'cancelled' },
      })
      if (updated.count !== 1) {
        const exists = await deps.prisma.email.findFirst({ where: { id, ownerId: userId }, select: { id: true } })
        if (!exists) throw new AppError(404, 'EMAIL_NOT_FOUND', 'Email not found')
        throw new AppError(409, 'EMAIL_NOT_CANCELLABLE', 'Only scheduled emails can be cancelled')
      }

      const email = await deps.prisma.email.findFirst({
        where: { id, ownerId: userId },
        select: { id: true, jobId: true, status: true },
      })
      let queueCleanupPending = false
      if (email?.jobId && deps.queue?.remove) {
        try {
          queueCleanupPending = !(await deps.queue.remove(email.jobId))
        } catch (err) {
          queueCleanupPending = true
          logger.warn({ emailId: id, err }, 'cancelled email job could not be removed from BullMQ; worker will skip the cancelled row')
        }
      } else if (email?.jobId) {
        queueCleanupPending = true
      }
      res.json({ id, status: 'cancelled', queueCleanupPending })
    } catch (err) {
      next(err)
    }
  }

  const setStarred: RequestHandler = async (req, res, next) => {
    try {
      const userId = req.user?.id
      if (!userId) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required')
      const id = emailIdSchema.parse(req.params.id)
      const { starred } = starredSchema.parse(req.body)
      const updated = await deps.prisma.email.updateMany({
        where: { id, ownerId: userId },
        data: { starred },
      })
      if (updated.count !== 1) throw new AppError(404, 'EMAIL_NOT_FOUND', 'Email not found')
      const email = await deps.prisma.email.findFirst({
        where: { id, ownerId: userId },
        select: { id: true, starred: true },
      })
      res.json({ email })
    } catch (err) {
      next(err)
    }
  }

  return { list, detail, counts, cancel, setStarred }
}

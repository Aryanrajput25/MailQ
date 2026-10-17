import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { ExpressAdapter } from '@bull-board/express'
import type { Queue } from 'bullmq'
import { Router, type RequestHandler } from 'express'
import type { EmailJobData } from '../queues/email.queue'
import { AppError } from '../utils/errors'

function requireQueueAdmin(adminEmails: readonly string[]): RequestHandler {
  const allowedEmails = new Set(adminEmails.map((email) => email.trim().toLowerCase()))
  return (req, _res, next) => {
    const user = req.user
    if (!user?.id || !user.email || !allowedEmails.has(user.email.trim().toLowerCase())) {
      next(new AppError(403, 'ADMIN_REQUIRED', 'Administrator access required'))
      return
    }
    next()
  }
}

export function createQueueDashboardRouter(
  queue: Queue<EmailJobData>,
  authenticate: RequestHandler,
  adminEmails: readonly string[],
): Router {
  const adapter = new ExpressAdapter().setBasePath('/admin/queues')
  createBullBoard({
    queues: [new BullMQAdapter(queue, { readOnlyMode: true })],
    serverAdapter: adapter,
    options: { uiConfig: { boardTitle: 'ReachInbox Queue Monitor' } },
  })

  const router = Router()
  router.use(authenticate)
  router.use(requireQueueAdmin(adminEmails))
  router.use(adapter.getRouter())
  return router
}

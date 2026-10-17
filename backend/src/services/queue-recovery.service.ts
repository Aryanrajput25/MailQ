import type { PrismaClient } from '@prisma/client'
import type { EmailQueuePort, QueueableEmail } from '../queues/email.queue'
import { logger } from '../utils/logger'

/** Drains the transactional outbox. It is recovery plumbing, not a scheduler: BullMQ owns timing. */
export class QueueRecoveryService {
  constructor(private readonly prisma: PrismaClient, private readonly queue: EmailQueuePort, private readonly now: () => Date = () => new Date()) {}

  async reconcile(limit = 500): Promise<{ queued: number; failed: number }> {
    const pending = await this.prisma.queueOutbox.findMany({
      where: { deliveredAt: null, nextAttemptAt: { lte: this.now() }, email: { status: 'scheduled' } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, emailId: true, jobId: true, email: { select: { scheduledAt: true } } },
    })
    let queued = 0
    let failed = 0
    for (const event of pending) {
      const email: QueueableEmail = { id: event.emailId, jobId: event.jobId, scheduledAt: event.email.scheduledAt.toISOString() }
      try {
        await this.queue.enqueue([email])
        await this.prisma.queueOutbox.updateMany({ where: { id: event.id, deliveredAt: null }, data: { deliveredAt: this.now(), lastError: null } })
        queued++
      } catch (error) {
        const attempts = await this.prisma.queueOutbox.updateMany({
          where: { id: event.id, deliveredAt: null },
          data: { attemptCount: { increment: 1 }, lastError: error instanceof Error ? error.message.slice(0, 1000) : 'Queue insertion failed', nextAttemptAt: new Date(this.now().getTime() + 30_000) },
        })
        failed += attempts.count
        logger.warn({ outboxId: event.id, emailId: event.emailId, error }, 'queue outbox delivery failed; will retry')
      }
    }
    return { queued, failed }
  }

  /**
   * Recovers emails stranded in `processing` by a crashed worker (BullMQ's own stalled-job handling covers
   * most cases; this covers jobs that already failed/vanished). Idempotent and safe to repeat.
   *  - smtpAttemptedAt == null: the worker never reached SMTP -> back to `scheduled` and a job is ensured.
   *  - smtpAttemptedAt != null: delivery outcome is unknown -> marked failed as UNCERTAIN, never auto-resent.
   */
  async recoverStaleProcessing(staleMs: number, limit = 200): Promise<{ requeued: number; uncertain: number }> {
    const cutoff = new Date(this.now().getTime() - staleMs)
    const stale = await this.prisma.email.findMany({
      where: { status: 'processing', processingStartedAt: { lt: cutoff } },
      orderBy: { processingStartedAt: 'asc' },
      take: limit,
      select: { id: true, jobId: true, scheduledAt: true, smtpAttemptedAt: true, processingStartedAt: true },
    })
    let requeued = 0
    let uncertain = 0
    for (const row of stale) {
      const guard = { id: row.id, status: 'processing' as const, processingStartedAt: row.processingStartedAt }
      if (row.smtpAttemptedAt) {
        const res = await this.prisma.email.updateMany({
          where: guard,
          data: {
            status: 'failed',
            processingStartedAt: null,
            failureReason: `UNCERTAIN: a worker was lost during the SMTP attempt; the message may have been delivered. Not resent automatically to avoid a duplicate.`,
          },
        })
        uncertain += res.count
        continue
      }
      const res = await this.prisma.email.updateMany({ where: guard, data: { status: 'scheduled', processingStartedAt: null } })
      if (res.count !== 1) continue
      try {
        if (row.jobId) await this.queue.ensureJob([{ id: row.id, jobId: row.jobId, scheduledAt: row.scheduledAt.toISOString() }])
        requeued++
      } catch (error) {
        logger.warn({ emailId: row.id, error }, 'could not re-create the queue job for a recovered email; the outbox will retry')
        // Make the next outbox pass pick it up again.
        await this.prisma.queueOutbox.updateMany({ where: { emailId: row.id }, data: { deliveredAt: null, nextAttemptAt: new Date() } })
      }
    }
    return { requeued, uncertain }
  }
}

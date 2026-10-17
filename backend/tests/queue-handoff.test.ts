import { describe, expect, it, vi } from 'vitest'
import { QueueEnqueueError } from '../src/queues/email.queue'
import { SchedulingService } from '../src/services/scheduling.service'

describe('scheduling queue handoff', () => {
  it('returns an accurate 503 when already-persisted rows cannot be queued', async () => {
    const enqueue = vi.fn().mockRejectedValue(new QueueEnqueueError(new Error('redis unavailable')))
    const startAt = new Date(Date.now() + 60_000)
    const prisma = {
      $transaction: async (callback: (tx: unknown) => unknown) =>
        callback({
          campaign: {
            findUnique: async () => ({
              id: 'campaign-1', ownerId: 'user-1', senderId: 'sender-1', subject: 'Hi', startAt, delaySeconds: 0, hourlyLimit: null,
              idempotencyKey: 'replay-key', requestHash: null, recipientCount: 1, createdAt: startAt,
              sender: { id: 'sender-1', email: 'sender@example.com' },
            }),
          },
          email: { findMany: async () => [{ id: 'email-1', recipientEmail: 'to@example.com', scheduledAt: startAt, status: 'scheduled', jobId: 'email_email-1' }] },
        }),
    } as any
    const service = new SchedulingService(prisma, { maxRecipientsPerBatch: 10, maxHourlyLimit: 100 }, Date.now, { enqueue, ensureJob: async () => undefined, close: async () => undefined })

    await expect(
      service.schedule(
        { id: 'user-1', email: 'user@example.com', name: 'User' },
        { from: 'sender@example.com', to: ['to@example.com'], subject: 'Hi', bodyHtml: '<p>Hi</p>' },
        'replay-key',
      ),
    ).rejects.toMatchObject({ status: 503, code: 'QUEUE_UNAVAILABLE', details: { persisted: true } })
    expect(enqueue).toHaveBeenCalledWith([expect.objectContaining({ id: 'email-1', jobId: 'email_email-1' })])
  })
})

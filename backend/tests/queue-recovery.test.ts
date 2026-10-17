import { describe, expect, it, vi } from 'vitest'
import { QueueRecoveryService } from '../src/services/queue-recovery.service'

describe('transactional queue outbox recovery', () => {
  it('enqueues a persisted event then marks it delivered', async () => {
    const at = new Date('2030-01-01T00:05:00.000Z')
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const prisma = { queueOutbox: { findMany: vi.fn().mockResolvedValue([{ id: 'o1', emailId: 'e1', jobId: 'email_e1', email: { scheduledAt: at } }]), updateMany } } as any
    const queue = { enqueue: vi.fn().mockResolvedValue(undefined), ensureJob: async () => undefined, close: async () => undefined }
    const recovery = new QueueRecoveryService(prisma, queue, () => new Date('2030-01-01T00:00:00.000Z'))
    await expect(recovery.reconcile()).resolves.toEqual({ queued: 1, failed: 0 })
    expect(queue.enqueue).toHaveBeenCalledWith([{ id: 'e1', jobId: 'email_e1', scheduledAt: at.toISOString() }])
    expect(updateMany.mock.calls[0]![0]).toMatchObject({ where: { id: 'o1', deliveredAt: null }, data: { lastError: null } })
  })

  it('retains a failed handoff and defers a later recovery attempt', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const prisma = { queueOutbox: { findMany: vi.fn().mockResolvedValue([{ id: 'o2', emailId: 'e2', jobId: 'email_e2', email: { scheduledAt: new Date() } }]), updateMany } } as any
    const queue = { enqueue: vi.fn().mockRejectedValue(new Error('Redis unavailable')), ensureJob: async () => undefined, close: async () => undefined }
    const recovery = new QueueRecoveryService(prisma, queue, () => new Date('2030-01-01T00:00:00.000Z'))
    await expect(recovery.reconcile()).resolves.toEqual({ queued: 0, failed: 1 })
    expect(updateMany.mock.calls[0]![0]).toMatchObject({ data: { attemptCount: { increment: 1 }, lastError: 'Redis unavailable' } })
  })
})

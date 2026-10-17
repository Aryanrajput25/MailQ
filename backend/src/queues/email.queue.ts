import { Queue, type JobsOptions } from 'bullmq'
import type { Redis } from 'ioredis'

export const EMAIL_QUEUE_NAME = 'email-delivery'
export const EMAIL_JOB_NAME = 'deliver-email'

export interface EmailJobData {
  emailId: string
}

export interface QueueableEmail {
  id: string
  jobId: string | null
  scheduledAt: string
}

export interface EmailQueuePort {
  enqueue(emails: QueueableEmail[]): Promise<void>
  /**
   * Guarantees one runnable job exists for each email. Unlike `enqueue`, it also replaces a retained
   * completed/failed job (BullMQ ignores `add` for an existing jobId, which would silently lose the email).
   */
  ensureJob(emails: QueueableEmail[]): Promise<void>
  /** Removes a queued job when it is not active; the database status remains authoritative. */
  remove?(jobId: string): Promise<boolean>
  close(): Promise<void>
}

export interface EmailQueueConfig {
  attempts: number
  backoffMs: number
}

export function buildEmailJobs(emails: QueueableEmail[], config: EmailQueueConfig, now = Date.now()) {
  return emails.map((email) => {
    if (!email.jobId) throw new QueueEnqueueError(new Error(`Email ${email.id} has no deterministic job id`))
    const delay = Math.max(0, new Date(email.scheduledAt).getTime() - now)
    const opts: JobsOptions = {
      jobId: email.jobId,
      delay,
      attempts: config.attempts,
      backoff: { type: 'exponential', delay: config.backoffMs },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    }
    return { name: EMAIL_JOB_NAME, data: { emailId: email.id }, opts }
  })
}

/** Raised after PostgreSQL committed but Redis did not accept the jobs. */
export class QueueEnqueueError extends Error {
  constructor(cause: unknown) {
    super('The email records were saved, but their queue jobs could not be created. Retry the same request.', { cause })
    this.name = 'QueueEnqueueError'
  }
}

/**
 * A thin BullMQ boundary. The persisted deterministic jobId makes `addBulk` safe to
 * repeat after a client retry or a future reconciliation pass.
 */
export class EmailQueue implements EmailQueuePort {
  private readonly queue: Queue<EmailJobData>

  constructor(connection: Redis, private readonly config: EmailQueueConfig, now: () => number = Date.now, queueName: string = EMAIL_QUEUE_NAME) {
    this.queue = new Queue<EmailJobData>(queueName, { connection })
    this.now = now
  }

  getBullMQQueue(): Queue<EmailJobData> {
    return this.queue
  }

  private readonly now: () => number

  async enqueue(emails: QueueableEmail[]): Promise<void> {
    if (emails.length === 0) return
    const jobs = buildEmailJobs(emails, this.config, this.now())
    try {
      await this.queue.addBulk(jobs)
    } catch (error) {
      throw new QueueEnqueueError(error)
    }
  }

  async ensureJob(emails: QueueableEmail[]): Promise<void> {
    try {
      for (const email of emails) {
        const [job] = buildEmailJobs([email], this.config, this.now())
        const existing = await this.queue.getJob(job!.opts.jobId!)
        if (existing) {
          const state = await existing.getState()
          if (state !== 'completed' && state !== 'failed') continue // waiting, delayed, active, prioritized: already runnable
          await existing.remove()
        }
        await this.queue.add(job!.name, job!.data, job!.opts)
      }
    } catch (error) {
      throw new QueueEnqueueError(error)
    }
  }

  async remove(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId)
    if (!job) return true
    if ((await job.getState()) === 'active') return false
    await job.remove()
    return true
  }

  close(): Promise<void> {
    return this.queue.close()
  }
}

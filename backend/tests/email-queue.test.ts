import { describe, expect, it } from 'vitest'
import { buildEmailJobs, EMAIL_JOB_NAME, QueueEnqueueError } from '../src/queues/email.queue'
import { jobIdForEmail } from '../src/utils/ids'

describe('email BullMQ jobs', () => {
  it('creates deterministic delayed jobs with bounded exponential retries', () => {
    const now = Date.parse('2030-01-01T00:00:00.000Z')
    const id = 'eml_123'
    const [job] = buildEmailJobs(
      [{ id, jobId: jobIdForEmail(id), scheduledAt: '2030-01-01T00:05:00.000Z' }],
      { attempts: 3, backoffMs: 5000 },
      now,
    )
    expect(job).toMatchObject({
      name: EMAIL_JOB_NAME,
      data: { emailId: id },
      opts: { jobId: 'email_eml_123', delay: 300_000, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    })
  })

  it('does not create a queue job without a persisted deterministic job id', () => {
    expect(() => buildEmailJobs([{ id: 'missing', jobId: null, scheduledAt: new Date().toISOString() }], { attempts: 1, backoffMs: 100 })).toThrow(
      QueueEnqueueError,
    )
  })
})

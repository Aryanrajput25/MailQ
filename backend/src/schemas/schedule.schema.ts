import { z } from 'zod'

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
export const MAX_SUBJECT_LENGTH = 200
export const MAX_BODY_HTML_LENGTH = 200_000
export const MAX_DELAY_SECONDS = 3600

const recipient = z.union(
  [z.string(), z.object({ email: z.string(), name: z.string().max(200).optional() })],
  { error: 'Each recipient must be an email string or an object like { "email": "a@b.co" }' },
)

/**
 * Field names match the frontend's `EmailDraft` (`from`, `to`, `subject`, `bodyHtml`,
 * `delayBetweenSeconds`, `hourlyLimit`) plus `scheduledAt`.
 * Unknown keys (e.g. a client-supplied `ownerId`) are stripped and never read: ownership always
 * comes from the authenticated session.
 */
export const scheduleBodySchema = z.object({
  from: z.string({ error: 'Sender email ("from") is required' }),
  to: z
    .array(recipient, { error: '"to" must be an array of recipients' })
    .min(1, 'Add at least one recipient'),
  subject: z.string({ error: 'Subject is required' }),
  bodyHtml: z.string({ error: 'Email body ("bodyHtml") is required' }).max(MAX_BODY_HTML_LENGTH, 'Email body is too large'),
  // ISO-8601 with an explicit UTC offset, e.g. 2026-11-01T09:00:00Z. Omit to send as soon as possible.
  scheduledAt: z.string().optional(),
  // Campaign pacing: seconds between consecutive emails of this request (distinct from the global MIN_DELAY_MS).
  delayBetweenSeconds: z
    .number({ error: '"delayBetweenSeconds" must be a number' })
    .int('Delay must be a whole number of seconds')
    .min(0, 'Delay cannot be negative')
    .max(MAX_DELAY_SECONDS, `Delay cannot exceed ${MAX_DELAY_SECONDS} seconds`)
    .optional(),
  hourlyLimit: z.number({ error: '"hourlyLimit" must be a number' }).int('Hourly limit must be a whole number').optional(),
  idempotencyKey: z.string().optional(),
  // Not supported yet; rejected explicitly instead of being silently dropped.
  attachments: z.array(z.unknown()).optional(),
})

export type ScheduleBody = z.infer<typeof scheduleBodySchema>

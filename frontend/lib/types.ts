export interface User {
  id: string
  name: string
  email: string
  avatarUrl?: string
}

export interface Recipient {
  email: string
  name?: string
}

export interface Attachment {
  id: string
  name: string
  sizeBytes: number
  mimeType: string
  url: string
}

export type EmailStatus = 'scheduled' | 'processing' | 'sent' | 'failed' | 'cancelled'
export type MailFolder = 'scheduled' | 'sent' | 'failed'

interface BaseEmail {
  id: string
  from: Recipient
  to: Recipient[]
  subject: string
  bodyHtml: string
  preview: string
  attachments: Attachment[]
  starred: boolean
  createdAt: string
}

export interface ScheduledEmail extends BaseEmail {
  status: Exclude<EmailStatus, 'sent'>
  scheduledAt: string
  delayBetweenSeconds?: number
  hourlyLimit?: number
  failureReason?: string
}

export interface SentEmail extends BaseEmail {
  status: 'sent'
  sentAt: string
}

export type Email = ScheduledEmail | SentEmail

export interface EmailDraft {
  from: string
  to: Recipient[]
  subject: string
  bodyHtml: string
  attachments: Attachment[]
  delayBetweenSeconds?: number
  hourlyLimit?: number
}

export interface MailboxCounts {
  scheduled: number
  processing: number
  sent: number
  failed: number
  cancelled: number
  pending: number
  total: number
}

export interface ListFilters {
  starredOnly?: boolean
}

export interface EmailPage {
  items: Email[]
  pagination: { page: number; pageSize: number; total: number; pageCount: number }
}

export interface ScheduleResult {
  replayed: boolean
  campaign: { id: string; startAt: string; recipientCount: number }
  recipients: { accepted: number; submitted?: number; duplicatesRemoved?: number }
  emails: { id: string; to: string; scheduledAt: string; status: string; jobId: string | null }[]
  idempotencyKey?: string
}

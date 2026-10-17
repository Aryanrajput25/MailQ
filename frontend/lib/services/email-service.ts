import { apiRequest, ApiError } from '@/lib/services/api-client'
import type {
  Email,
  EmailDraft,
  EmailPage,
  EmailStatus,
  ListFilters,
  MailFolder,
  MailboxCounts,
  Recipient,
  ScheduleResult,
} from '@/lib/types'

interface ApiEmail {
  id: string
  status: EmailStatus
  subject: string
  bodyHtml: string
  recipientEmail: string
  recipientName: string | null
  scheduledAt: string
  sentAt: string | null
  createdAt: string
  starred: boolean
  failureReason: string | null
  sender: { email: string; displayName: string | null }
}

interface ApiEmailPage {
  items: ApiEmail[]
  pagination: { page: number; pageSize: number; total: number; pageCount: number }
}

export interface ScheduleOptions {
  scheduledAt?: Date
  idempotencyKey: string
}

function toPreview(html: string, length = 140): string {
  const text = html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
  return text.length > length ? `${text.slice(0, length).trimEnd()}…` : text
}

function mapEmail(email: ApiEmail): Email {
  const common = {
    id: email.id,
    from: { email: email.sender.email, ...(email.sender.displayName ? { name: email.sender.displayName } : {}) },
    to: [{ email: email.recipientEmail, ...(email.recipientName ? { name: email.recipientName } : {}) }],
    subject: email.subject,
    bodyHtml: email.bodyHtml,
    preview: toPreview(email.bodyHtml),
    attachments: [],
    starred: email.starred,
    createdAt: email.createdAt,
    failureReason: email.failureReason ?? undefined,
  }
  if (email.status === 'sent') {
    return { ...common, status: 'sent', sentAt: email.sentAt ?? email.createdAt }
  }
  return {
    ...common,
    status: email.status,
    scheduledAt: email.scheduledAt,
  }
}

export async function listEmails(
  folder: MailFolder,
  query = '',
  filters: ListFilters = {},
  page = 1,
): Promise<EmailPage> {
  const params = new URLSearchParams({
    folder: folder === 'failed' ? 'all' : folder,
    page: String(page),
    pageSize: '25',
    sort: folder === 'sent' ? 'sentAt' : 'scheduledAt',
    order: folder === 'scheduled' ? 'asc' : 'desc',
  })
  if (query.trim()) params.set('search', query.trim())
  if (filters.starredOnly) params.set('starred', 'true')
  if (folder === 'failed') params.set('status', 'failed')

  const response = await apiRequest<ApiEmailPage>(`/api/emails?${params}`)
  return {
    items: response.items.map(mapEmail),
    pagination: response.pagination,
  }
}

export async function getEmail(id: string): Promise<Email | null> {
  try {
    const response = await apiRequest<{ email: ApiEmail }>(`/api/emails/${encodeURIComponent(id)}`)
    return mapEmail(response.email)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

export function getCounts(): Promise<MailboxCounts> {
  return apiRequest<MailboxCounts>('/api/emails/counts')
}

export async function toggleStar(id: string, starred: boolean): Promise<void> {
  await apiRequest(`/api/emails/${encodeURIComponent(id)}/star`, {
    method: 'PATCH',
    body: JSON.stringify({ starred }),
  })
}

export async function cancelEmail(id: string): Promise<{ id: string; status: 'cancelled'; queueCleanupPending: boolean }> {
  return apiRequest(`/api/emails/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export async function scheduleEmail(draft: EmailDraft, options: ScheduleOptions): Promise<ScheduleResult> {
  if (draft.to.length === 0) throw new Error('Add at least one recipient.')
  if (!draft.subject.trim()) throw new Error('Add a subject before submitting.')
  if (!draft.bodyHtml.replace(/<[^>]*>/g, '').trim()) throw new Error('Add email content before submitting.')
  if (draft.attachments.length > 0) throw new Error('Attachments are not supported by the email API yet.')
  if (options.scheduledAt && (!Number.isFinite(options.scheduledAt.getTime()) || options.scheduledAt.getTime() <= Date.now())) {
    throw new Error('The scheduled time must be in the future.')
  }

  return apiRequest<ScheduleResult>('/api/emails/schedule', {
    method: 'POST',
    headers: { 'idempotency-key': options.idempotencyKey },
    body: JSON.stringify({
      from: draft.from,
      to: draft.to,
      subject: draft.subject,
      bodyHtml: draft.bodyHtml,
      ...(options.scheduledAt ? { scheduledAt: options.scheduledAt.toISOString() } : {}),
      ...(draft.delayBetweenSeconds === undefined ? {} : { delayBetweenSeconds: draft.delayBetweenSeconds }),
      ...(draft.hourlyLimit === undefined ? {} : { hourlyLimit: draft.hourlyLimit }),
    }),
  })
}

export async function getSlackConnection() {
  return apiRequest<{ connected: boolean; team?: string; channel?: string | null; revoked?: boolean }>('/api/slack/connection')
}

export async function disconnectSlack(): Promise<void> {
  await apiRequest<void>('/api/slack/connection', { method: 'DELETE' })
}

export function displayRecipient(recipient: Recipient) {
  return recipient.name ? `${recipient.name} <${recipient.email}>` : recipient.email
}

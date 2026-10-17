import type { Metadata } from 'next'
import { MailboxView } from '@/components/mail/mailbox-view'

export const metadata: Metadata = { title: 'Scheduled' }

export default function ScheduledPage() {
  return <MailboxView folder="scheduled" />
}

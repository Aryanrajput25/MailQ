import type { Metadata } from 'next'
import { MailboxView } from '@/components/mail/mailbox-view'

export const metadata: Metadata = { title: 'Sent' }

export default function SentPage() {
  return <MailboxView folder="sent" />
}

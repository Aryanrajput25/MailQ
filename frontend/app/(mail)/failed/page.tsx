import type { Metadata } from 'next'
import { MailboxView } from '@/components/mail/mailbox-view'

export const metadata: Metadata = { title: 'Failed' }

export default function FailedPage() {
  return <MailboxView folder="failed" />
}

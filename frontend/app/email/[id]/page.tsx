import type { Metadata } from 'next'
import { EmailDetail } from '@/components/email/email-detail'
import { AuthGate } from '@/components/auth/auth-gate'

export const metadata: Metadata = { title: 'Email' }

export default async function EmailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <AuthGate>
      <EmailDetail id={id} />
    </AuthGate>
  )
}

import type { Metadata } from 'next'
import { ComposeForm } from '@/components/compose/compose-form'
import { AuthGate } from '@/components/auth/auth-gate'

export const metadata: Metadata = { title: 'Compose New Email' }

export default function ComposePage() {
  return (
    <AuthGate>
      <ComposeForm />
    </AuthGate>
  )
}

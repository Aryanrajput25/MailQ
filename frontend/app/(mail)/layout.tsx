import { Sidebar } from '@/components/mail/sidebar'
import { AuthGate } from '@/components/auth/auth-gate'

export default function MailLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <div className="flex min-h-dvh bg-background">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </AuthGate>
  )
}

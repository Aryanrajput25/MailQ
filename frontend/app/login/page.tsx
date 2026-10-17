import type { Metadata } from 'next'
import { LoginForm } from '@/components/auth/login-form'
import { Logo } from '@/components/brand/logo'

export const metadata: Metadata = { title: 'Login' }

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh flex-col bg-secondary">
      <header className="px-6 py-5 sm:px-8">
        <Logo className="text-2xl" />
      </header>
      <div className="flex flex-1 items-center justify-center px-4 pb-16">
        <LoginForm />
      </div>
    </main>
  )
}

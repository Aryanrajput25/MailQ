'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { GoogleIcon } from '@/components/brand/logo'
import { Button } from '@/components/ui/button'
import { useCurrentUser } from '@/hooks/use-mail'
import { ApiError, apiUrl } from '@/lib/services/api-client'

export function LoginForm() {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [loginError, setLoginError] = useState<string>()
  const { data: user, error } = useCurrentUser()
  const unauthenticated = error instanceof ApiError && error.status === 401

  useEffect(() => {
    if (user) router.replace('/scheduled')
  }, [router, user])

  function handleGoogleLogin() {
    try {
      setPending(true)
      window.location.assign(apiUrl('/api/auth/google'))
    } catch (error) {
      setPending(false)
      setLoginError(error instanceof Error ? error.message : 'Could not start Google sign-in.')
    }
  }

  return (
    <section
      aria-labelledby="login-heading"
      className="w-full max-w-[400px] rounded-xl border border-border bg-card px-6 py-9 shadow-[0_1px_2px_rgba(23,26,25,0.04)] sm:px-10"
    >
      <h1
        id="login-heading"
        className="text-center text-[28px] font-semibold tracking-tight text-foreground text-balance"
      >
        Login
      </h1>
      <p className="mt-1.5 text-center text-sm text-muted-foreground">
        Schedule and send outreach that lands.
      </p>
      <Button
        type="button"
        onClick={handleGoogleLogin}
        disabled={pending}
        className="mt-7 h-10 w-full gap-2.5"
      >
        {pending ? <Loader2 className="animate-spin" /> : <GoogleIcon />}
        Continue with Google
      </Button>
      {(loginError || (error && !unauthenticated)) && (
        <p role="alert" className="mt-4 text-center text-xs text-destructive">
          {loginError ?? error.message}
        </p>
      )}
    </section>
  )
}

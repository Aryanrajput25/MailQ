'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, WifiOff } from 'lucide-react'
import { useCurrentUser } from '@/hooks/use-mail'
import { ApiError } from '@/lib/services/api-client'

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true'

export function AuthGate({ children }: { children: React.ReactNode }) {
    const router = useRouter()
    const { data: user, error, mutate } = useCurrentUser()

    const unauthenticated = error instanceof ApiError && error.status === 401

    useEffect(() => {
        if (DEMO_MODE) return

        const redirectToLogin = () => {
            void mutate(undefined, { revalidate: false })
            router.replace('/login')
        }

        window.addEventListener('reachinbox:unauthorized', redirectToLogin)

        if (unauthenticated) redirectToLogin()

        return () =>
            window.removeEventListener('reachinbox:unauthorized', redirectToLogin)
    }, [mutate, router, unauthenticated])

    // Frontend-only demo: bypass backend session verification.
    if (DEMO_MODE) return children

    if (user) return children

    if (!error || unauthenticated) {
        return (
            <main
                className="flex min-h-dvh items-center justify-center"
                aria-live="polite"
            >
                <Loader2
                    className="size-5 animate-spin text-muted-foreground"
                    aria-label="Checking sign-in"
                />
            </main>
        )
    }

    return (
        <main className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
            <WifiOff className="size-6 text-muted-foreground" aria-hidden="true" />
            <h1 className="mt-3 text-sm font-semibold">
                Could not verify your session
            </h1>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {error.message}
            </p>
            <button
                type="button"
                onClick={() => void mutate()}
                className="mt-4 rounded-full border border-border px-4 py-2 text-sm hover:bg-muted"
            >
                Retry
            </button>
        </main>
    )
}
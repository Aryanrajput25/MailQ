'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Loader2, MailX, Star, XCircle, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import { headerIconButton, PageHeader } from '@/components/mail/page-header'
import { EmptyState } from '@/components/mail/states'
import { StatusBadge } from '@/components/mail/status-badge'
import { UserAvatar } from '@/components/mail/user-profile'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useCurrentUser, useEmail, useRevalidateMail } from '@/hooks/use-mail'
import { displayName, formatFullDate, initials } from '@/lib/format'
import { sanitizeHtml } from '@/lib/sanitize'
import { cancelEmail, toggleStar } from '@/lib/services/email-service'
import type { Email } from '@/lib/types'
import { cn } from '@/lib/utils'

function folderHref(email?: Email | null) {
  if (email?.status === 'sent') return '/sent'
  if (email?.status === 'failed') return '/failed'
  return '/scheduled'
}

export function EmailDetail({ id }: { id: string }) {
  const router = useRouter()
  const { data: email, error, isLoading, mutate } = useEmail(id)
  const { data: user } = useCurrentUser()
  const revalidateAll = useRevalidateMail()
  const [cancelling, setCancelling] = useState(false)
  const safeHtml = useMemo(() => (email ? sanitizeHtml(email.bodyHtml) : ''), [email])

  async function handleStar() {
    if (!email) return
    mutate({ ...email, starred: !email.starred }, { revalidate: false })
    try {
      await toggleStar(email.id, !email.starred)
      await mutate()
      revalidateAll()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update star.')
      mutate()
    }
  }

  async function handleCancel() {
    if (!email || email.status !== 'scheduled' || cancelling) return
    setCancelling(true)
    try {
      const result = await cancelEmail(email.id)
      await revalidateAll()
      toast.success(result.queueCleanupPending
        ? 'Cancelled. The worker will safely skip the queued job.'
        : 'Scheduled email cancelled.')
      router.push('/scheduled')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not cancel this email.')
      setCancelling(false)
    }
  }

  const actions = (
    <>
      <button
        type="button"
        onClick={handleStar}
        disabled={!email}
        aria-pressed={email?.starred}
        aria-label={email?.starred ? 'Unstar' : 'Star'}
        className={cn(headerIconButton, email?.starred && 'text-warning hover:text-warning')}
      >
        <Star className={cn('size-4', email?.starred && 'fill-current')} />
      </button>
      {email?.status === 'scheduled' && (
        <button
          type="button"
          onClick={() => void handleCancel()}
          disabled={cancelling}
          aria-label="Cancel scheduled email"
          className={cn(headerIconButton, 'hover:bg-destructive-soft hover:text-destructive')}
        >
          {cancelling ? <Loader2 className="size-4 animate-spin" /> : <XCircle className="size-4" />}
        </button>
      )}
      <span className="mx-1.5 hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
      <span className="hidden sm:block">
        {user && <UserAvatar user={user} size={30} />}
      </span>
    </>
  )

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <PageHeader
        fallbackHref={folderHref(email)}
        title={isLoading ? <span className="inline-block h-4 w-56 animate-pulse rounded bg-muted align-middle" /> : email?.subject ?? 'Email'}
        actions={actions}
      />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 md:px-8 md:py-8">
        {isLoading ? (
          <DetailSkeleton />
        ) : error ? (
          <EmptyState
            icon={WifiOff}
            title="Couldn't load email"
            description={error instanceof Error ? error.message : 'Check your connection and try again.'}
            action={{ label: 'Retry', onClick: () => void mutate() }}
          />
        ) : !email ? (
          <EmptyState
            icon={MailX}
            title="Email not found"
            description="It may have been deleted or the link is incorrect."
            action={{ label: 'Back to inbox', onClick: () => router.push('/scheduled') }}
          />
        ) : (
          <article aria-labelledby="email-subject">
            <h2 id="email-subject" className="sr-only">
              {email.subject}
            </h2>
            <div className="flex items-start gap-3">
              <span
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground"
                aria-hidden="true"
              >
                {initials(email.from.name ?? email.from.email)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="min-w-0 truncate text-[13px]">
                    <span className="font-semibold text-foreground">{displayName(email.from)}</span>
                    {email.from.name && (
                      <span className="text-subtle-foreground"> {`<${email.from.email}>`}</span>
                    )}
                  </p>
                  <div className="flex items-center gap-2">
                    {email.status !== 'sent' && <StatusBadge email={email} />}
                    <time
                      dateTime={email.status === 'sent' ? email.sentAt : email.createdAt}
                      className="text-xs text-subtle-foreground tabular-nums"
                    >
                      {formatFullDate(email.status === 'sent' ? email.sentAt : email.createdAt)}
                    </time>
                  </div>
                </div>
                <RecipientDetails email={email} />
              </div>
            </div>

            <div
              className="email-prose mt-6 md:pl-12"
              dangerouslySetInnerHTML={{ __html: safeHtml }}
            />

          </article>
        )}
      </main>
    </div>
  )
}

function RecipientDetails({ email }: { email: Email }) {
  const { data: user } = useCurrentUser()
  const isMe = email.to.length === 1 && email.to[0].email === user?.email
  const summary = isMe ? 'to me' : `to ${email.to.map(displayName).slice(0, 2).join(', ')}${email.to.length > 2 ? ` +${email.to.length - 2}` : ''}`

  return (
    <Popover>
      <PopoverTrigger className="mt-0.5 inline-flex items-center gap-0.5 rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30">
        {summary}
        <ChevronDown className="size-3" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 text-xs">
        <dl className="grid grid-cols-[56px_1fr] gap-x-2 gap-y-2">
          <dt className="text-subtle-foreground">From</dt>
          <dd className="break-all text-foreground">{email.from.email}</dd>
          <dt className="text-subtle-foreground">To</dt>
          <dd className="break-all text-foreground">{email.to.map((r) => r.email).join(', ')}</dd>
          <dt className="text-subtle-foreground">Subject</dt>
          <dd className="text-foreground">{email.subject}</dd>
          {email.status !== 'sent' && (
            <>
              <dt className="text-subtle-foreground">Sends</dt>
              <dd className="text-foreground">{formatFullDate(email.scheduledAt)}</dd>
            </>
          )}
          {email.status === 'failed' && (
            <>
              <dt className="text-subtle-foreground">Error</dt>
              <dd className="text-destructive">{email.failureReason}</dd>
            </>
          )}
        </dl>
      </PopoverContent>
    </Popover>
  )
}

function DetailSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading email</span>
      <div className="flex items-start gap-3" aria-hidden="true">
        <div className="size-9 animate-pulse rounded-full bg-muted" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-48 animate-pulse rounded bg-muted" />
          <div className="h-3 w-16 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div className="mt-8 space-y-3 md:pl-12" aria-hidden="true">
        {[90, 75, 82, 40].map((w) => (
          <div key={w} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  )
}

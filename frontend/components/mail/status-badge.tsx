import { AlertCircle, Clock, Send } from 'lucide-react'
import { formatListTime } from '@/lib/format'
import type { Email } from '@/lib/types'
import { cn } from '@/lib/utils'

export function StatusBadge({ email, className }: { email: Email; className?: string }) {
  const base =
    'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium whitespace-nowrap tabular-nums'

  if (email.status === 'sent') {
    return (
      <span className={cn(base, 'bg-muted text-muted-foreground', className)}>
        <Send className="size-3" aria-hidden="true" />
        Sent
      </span>
    )
  }

  if (email.status === 'failed') {
    return (
      <span
        className={cn(base, 'bg-destructive-soft text-destructive', className)}
        title={email.failureReason}
      >
        <AlertCircle className="size-3" aria-hidden="true" />
        Failed
      </span>
    )
  }

  if (email.status === 'cancelled') {
    return (
      <span className={cn(base, 'bg-muted text-muted-foreground', className)}>
        Cancelled
      </span>
    )
  }

  return (
    <span className={cn(base, 'bg-accent text-accent-foreground', className)}>
      <Clock className="size-3" aria-hidden="true" />
      {email.status === 'processing' ? (
        <span>Sending</span>
      ) : (
        <>
          <span className="sr-only">Scheduled for </span>
          <time dateTime={email.scheduledAt}>{formatListTime(email.scheduledAt)}</time>
        </>
      )}
    </span>
  )
}

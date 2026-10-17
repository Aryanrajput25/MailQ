'use client'

import Link from 'next/link'
import { Paperclip, Star } from 'lucide-react'
import { StatusBadge } from '@/components/mail/status-badge'
import { displayName } from '@/lib/format'
import type { Email } from '@/lib/types'
import { cn } from '@/lib/utils'

interface EmailRowProps {
  email: Email
  onToggleStar: (email: Email) => void
}

export function EmailRow({ email, onToggleStar }: EmailRowProps) {
  const [first, ...rest] = email.to
  const recipients = first ? displayName(first) : 'No recipients'

  return (
    <li className="group relative flex items-start gap-3 border-b border-border px-4 py-3.5 transition-colors duration-150 hover:bg-secondary focus-within:bg-secondary md:items-center md:gap-4 md:px-6">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 md:flex-row md:items-center md:gap-4">
        <div className="flex items-center justify-between gap-3 md:w-44 md:shrink-0 lg:w-52">
          <p className="truncate text-[13px] text-foreground">
            <span className="text-muted-foreground">To: </span>
            <span className="font-medium">{recipients}</span>
            {rest.length > 0 && <span className="text-subtle-foreground"> +{rest.length}</span>}
          </p>
          <StatusBadge email={email} className="md:hidden" />
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <StatusBadge email={email} className="hidden md:inline-flex" />
          <Link
            href={`/email/${email.id}`}
            className="min-w-0 flex-1 truncate text-[13px] outline-none after:absolute after:inset-0 focus-visible:underline"
          >
            <span className="font-medium text-foreground">{email.subject}</span>
            <span className="text-subtle-foreground"> — {email.preview}</span>
          </Link>
          {email.attachments.length > 0 && (
            <Paperclip className="size-3.5 shrink-0 text-subtle-foreground" aria-label="Has attachments" />
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => onToggleStar(email)}
        aria-pressed={email.starred}
        aria-label={email.starred ? 'Unstar email' : 'Star email'}
        className={cn(
          'relative z-[1] -my-1 flex size-8 shrink-0 items-center justify-center rounded-md transition-colors duration-150 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30',
          email.starred ? 'text-warning' : 'text-border-strong hover:text-muted-foreground',
        )}
      >
        <Star className={cn('size-4', email.starred && 'fill-current')} />
      </button>
    </li>
  )
}

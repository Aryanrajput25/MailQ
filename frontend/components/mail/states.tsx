import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { Plus } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function LoadingState({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="divide-y divide-border">
      <span className="sr-only">Loading emails</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-4 md:px-6" aria-hidden="true">
          <div className="h-3 w-24 shrink-0 animate-pulse rounded bg-muted md:w-32" />
          <div className="h-5 w-20 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="h-3 flex-1 animate-pulse rounded bg-muted" style={{ maxWidth: `${60 - i * 5}%` }} />
        </div>
      ))}
    </div>
  )
}

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: { label: string; href?: string; onClick?: () => void }
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-20 text-center', className)}>
      <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-secondary">
        <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <h2 className="mt-4 text-sm font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-muted-foreground text-pretty">
        {description}
      </p>
      {action &&
        (action.href ? (
          <Link
            href={action.href}
            className={cn(buttonVariants({ variant: 'accent' }), 'mt-5 h-9 gap-1.5 px-3.5')}
          >
            <Plus aria-hidden="true" />
            {action.label}
          </Link>
        ) : (
          <button
            type="button"
            onClick={action.onClick}
            className={cn(buttonVariants({ variant: 'outline' }), 'mt-5 h-9 px-3.5')}
          >
            {action.label}
          </button>
        ))}
    </div>
  )
}

'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { AlertCircle, Clock, PenSquare, Send } from 'lucide-react'
import { Logo } from '@/components/brand/logo'
import { UserProfile } from '@/components/mail/user-profile'
import { buttonVariants } from '@/components/ui/button'
import { useCounts } from '@/hooks/use-mail'
import { useCurrentUser } from '@/hooks/use-mail'
import { cn } from '@/lib/utils'

const navItems = [
  { href: '/scheduled', label: 'Scheduled', icon: Clock, countKey: 'pending' },
  { href: '/sent', label: 'Sent', icon: Send, countKey: 'sent' },
  { href: '/failed', label: 'Failed', icon: AlertCircle, countKey: 'failed' },
] as const

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const { data: counts } = useCounts()
  const { data: user } = useCurrentUser()

  return (
    <div className="flex h-full flex-col gap-4 px-3 py-5">
      <div className="px-2">
        <Logo />
      </div>

      {user && <UserProfile user={user} />}

      <Link
        href="/compose"
        onClick={onNavigate}
        className={cn(buttonVariants({ variant: 'accent' }), 'h-9 w-full gap-2')}
      >
        <PenSquare aria-hidden="true" />
        Compose
      </Link>

      <nav aria-label="Mailboxes" className="mt-2">
        <p className="px-2.5 pb-1.5 text-[10px] font-medium tracking-[0.08em] text-subtle-foreground uppercase">
          Core
        </p>
        <ul className="flex flex-col gap-0.5">
          {navItems.map(({ href, label, icon: Icon, countKey }) => {
            const active = pathname === href
            return (
              <li key={href}>
                <Link
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'group flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
                    active
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon
                    className={cn(
                      'size-4 shrink-0',
                      active ? 'text-primary' : 'text-subtle-foreground group-hover:text-muted-foreground',
                    )}
                    aria-hidden="true"
                  />
                  <span className="flex-1">{label}</span>
                  <span
                    className={cn(
                      'text-[11px] tabular-nums',
                      active ? 'text-accent-foreground' : 'text-subtle-foreground',
                    )}
                  >
                    {counts ? counts[countKey] : ''}
                    <span className="sr-only"> emails</span>
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}

export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 border-r border-border bg-background md:block lg:w-60">
      <SidebarContent />
    </aside>
  )
}

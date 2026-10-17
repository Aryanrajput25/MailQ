'use client'

import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Bell, ChevronDown, LogOut, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { User } from '@/lib/types'
import { useCurrentUser, useSlackConnection } from '@/hooks/use-mail'
import { apiUrl, logout } from '@/lib/services/api-client'
import { disconnectSlack } from '@/lib/services/email-service'

export function UserAvatar({ user, size = 32 }: { user: User; size?: number }) {
  return user.avatarUrl ? (
    <Image
      src={user.avatarUrl}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-full object-cover ring-1 ring-border"
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-accent text-xs font-medium text-accent-foreground"
      style={{ width: size, height: size }}
    >
      {user.name[0]}
    </span>
  )
}

export function UserProfile({ user }: { user: User }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const { data: slack, error: slackError, mutate: refreshSlack } = useSlackConnection()
  const { mutate: refreshUser } = useCurrentUser()

  async function handleLogout() {
    if (pending) return
    setPending(true)
    try {
      await logout()
      await refreshUser(undefined, { revalidate: false })
      router.replace('/login')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not sign out.')
      setPending(false)
    }
  }

  async function handleSlack() {
    if (slack?.connected) {
      setPending(true)
      try {
        await disconnectSlack()
        await refreshSlack()
        toast.success('Slack disconnected')
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not disconnect Slack.')
      } finally {
        setPending(false)
      }
      return
    }
    if (slackError) {
      toast.error(slackError instanceof Error ? slackError.message : 'Slack connection is unavailable.')
      return
    }
    window.location.assign(apiUrl('/api/slack/connect'))
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-secondary px-2.5 py-2 text-left transition-colors duration-150 outline-none hover:border-border-strong hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 data-popup-open:bg-muted"
        aria-label={`Account menu for ${user.name}`}
      >
        <UserAvatar user={user} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">{user.name}</span>
          <span className="block truncate text-[11px] text-subtle-foreground">{user.email}</span>
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-52">
        <DropdownMenuItem disabled={pending} onClick={() => void handleSlack()}>
          {pending ? <Loader2 className="animate-spin" /> : <Bell />}
          {slackError
            ? 'Slack unavailable'
            : slack?.connected
              ? `Disconnect Slack${slack.team ? ` · ${slack.team}` : ''}`
              : 'Connect Slack'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={pending} onClick={() => void handleLogout()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

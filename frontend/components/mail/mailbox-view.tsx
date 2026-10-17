'use client'

import { useDeferredValue, useState } from 'react'
import { Clock, SearchX, Send, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import { EmailRow } from '@/components/mail/email-row'
import { MailboxToolbar } from '@/components/mail/mailbox-toolbar'
import { EmptyState, LoadingState } from '@/components/mail/states'
import { useEmails, useRevalidateMail } from '@/hooks/use-mail'
import { toggleStar } from '@/lib/services/email-service'
import type { Email, ListFilters, MailFolder } from '@/lib/types'

const copy: Record<MailFolder, { title: string; empty: string; emptyBody: string }> = {
  scheduled: {
    title: 'Scheduled',
    empty: 'Nothing scheduled yet',
    emptyBody: 'Compose an email and pick a time — it will wait here until it goes out.',
  },
  sent: {
    title: 'Sent',
    empty: 'No sent emails',
    emptyBody: 'Emails you send, or that go out on schedule, will show up here.',
  },
  failed: {
    title: 'Failed',
    empty: 'No failed emails',
    emptyBody: 'Emails that could not be delivered will be listed here.',
  },
}

export function MailboxView({ folder }: { folder: MailFolder }) {
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<ListFilters>({})
  const [page, setPage] = useState(1)
  const deferredQuery = useDeferredValue(query)
  const { data, error, isLoading, isValidating, mutate } = useEmails(folder, deferredQuery, filters, page)
  const revalidateAll = useRevalidateMail()

  async function handleToggleStar(email: Email) {
    mutate(
      (current) => current && ({
        ...current,
        items: current.items.map((e) => (e.id === email.id ? { ...e, starred: !e.starred } : e)),
      }),
      { revalidate: false },
    )
    try {
      await toggleStar(email.id, !email.starred)
    } catch {
      toast.error('Could not update star. Try again.')
      mutate()
    }
  }

  const isFiltering = Boolean(deferredQuery || filters.starredOnly)
  const { title, empty, emptyBody } = copy[folder]

  return (
    <main className="flex min-h-dvh flex-col" aria-labelledby="mailbox-title">
      <h1 id="mailbox-title" className="sr-only">
        {title}
      </h1>
      <MailboxToolbar
        query={query}
        onQueryChange={(value) => {
          setQuery(value)
          setPage(1)
        }}
        filters={filters}
        onFiltersChange={(value) => {
          setFilters(value)
          setPage(1)
        }}
        onRefresh={() => revalidateAll()}
        refreshing={isValidating && !isLoading}
      />

      <section aria-label={`${title} emails`} className="flex-1">
        {error ? (
          <EmptyState
            icon={WifiOff}
            title="Couldn't load emails"
            description={error instanceof Error ? error.message : 'Check your connection and try again.'}
            action={{ label: 'Retry', onClick: () => mutate() }}
          />
        ) : isLoading || !data ? (
          <LoadingState />
        ) : data.items.length === 0 ? (
          isFiltering ? (
            <EmptyState
              icon={SearchX}
              title="No matches"
              description="Try a different search term or clear your filters."
              action={{
                label: 'Clear search',
                onClick: () => {
                  setQuery('')
                  setFilters({})
                  setPage(1)
                },
              }}
            />
          ) : (
            <EmptyState
              icon={folder === 'sent' ? Send : Clock}
              title={empty}
              description={emptyBody}
              action={{ label: 'Compose', href: '/compose' }}
            />
          )
        ) : (
          <ul aria-busy={isValidating}>
            {data.items.map((email) => (
              <EmailRow key={email.id} email={email} onToggleStar={handleToggleStar} />
            ))}
          </ul>
        )}
      </section>
      {data && data.pagination.pageCount > 1 && (
        <nav aria-label="Email pages" className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
          <span>
            Page {data.pagination.page} of {data.pagination.pageCount} · {data.pagination.total} emails
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1 || isValidating}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              className="rounded-full border border-border px-3 py-1.5 disabled:opacity-50"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= data.pagination.pageCount || isValidating}
              onClick={() => setPage((value) => Math.min(data.pagination.pageCount, value + 1))}
              className="rounded-full border border-border px-3 py-1.5 disabled:opacity-50"
            >
              Next
            </button>
          </span>
        </nav>
      )}
    </main>
  )
}

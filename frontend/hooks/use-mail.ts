'use client'

import useSWR, { useSWRConfig } from 'swr'
import { getCounts, getEmail, getSlackConnection, listEmails } from '@/lib/services/email-service'
import { getCurrentUser } from '@/lib/services/api-client'
import type { ListFilters, MailFolder } from '@/lib/types'

export function useEmails(folder: MailFolder, query: string, filters: ListFilters, page = 1) {
  return useSWR(['emails', folder, query, filters.starredOnly, page], () =>
    listEmails(folder, query, filters, page),
    { keepPreviousData: true },
  )
}

export function useEmail(id: string) {
  return useSWR(['email', id], () => getEmail(id))
}

export function useCounts() {
  return useSWR('counts', getCounts)
}

export function useCurrentUser() {
  return useSWR('current-user', getCurrentUser, { shouldRetryOnError: false })
}

export function useSlackConnection() {
  return useSWR('slack-connection', getSlackConnection, { shouldRetryOnError: false })
}

export function useRevalidateMail() {
  const { mutate } = useSWRConfig()
  return () =>
    mutate(
      (key) =>
        key === 'counts' ||
        key === 'slack-connection' ||
        (Array.isArray(key) && (key[0] === 'emails' || key[0] === 'email')),
    )
}

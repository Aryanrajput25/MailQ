'use client'

import { useRef, useState } from 'react'
import { Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { extractEmails, isValidEmail } from '@/lib/format'
import type { Recipient } from '@/lib/types'
import { cn } from '@/lib/utils'

interface RecipientInputProps {
  id: string
  value: Recipient[]
  onChange: (recipients: Recipient[]) => void
  error?: string
  onClearError?: () => void
}

const COLLAPSED_LIMIT = 3
const MAX_LIST_BYTES = 2 * 1024 * 1024

export function RecipientInput({ id, value, onChange, error, onClearError }: RecipientInputProps) {
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string>()
  const [expanded, setExpanded] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function addEmails(emails: string[]) {
    const existing = new Set(value.map((r) => r.email.toLowerCase()))
    const fresh = emails
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e && !existing.has(e) && existing.add(e))
    if (fresh.length) {
      onChange([...value, ...fresh.map((email) => ({ email }))])
      onClearError?.()
    }
    return fresh.length
  }

  function commitDraft() {
    const tokens = draft.split(/[\s,;]+/).filter(Boolean)
    if (tokens.length === 0) {
      setDraft('')
      return true
    }
    const valid = tokens.filter(isValidEmail)
    const invalid = tokens.filter((t) => !isValidEmail(t))
    addEmails(valid)
    setDraft(invalid.join(' '))
    if (invalid.length) {
      setDraftError(
        invalid.length === 1
          ? `"${invalid[0]}" isn't a valid email address.`
          : `${invalid.length} entries aren't valid email addresses.`,
      )
      return false
    }
    setDraftError(undefined)
    return true
  }

  function remove(email: string) {
    onChange(value.filter((r) => r.email !== email))
    inputRef.current?.focus()
  }

  async function handleListUpload(file: File) {
    if (file.size > MAX_LIST_BYTES) {
      toast.error('List is too large. Max 2 MB.')
      return
    }
    const found = extractEmails(await file.text())
    if (found.length === 0) {
      toast.error(`No email addresses found in ${file.name}.`)
      return
    }
    const added = addEmails(found)
    setExpanded(false)
    toast.success(
      added === found.length
        ? `Added ${added} recipient${added === 1 ? '' : 's'}`
        : `Added ${added} new recipient${added === 1 ? '' : 's'} (${found.length - added} already in list)`,
    )
  }

  const visible = expanded ? value : value.slice(0, COLLAPSED_LIMIT)
  const hiddenCount = value.length - visible.length
  const message = draftError ?? error

  return (
    <div className="min-w-0 flex-1">
      <div
        className={cn(
          'flex min-h-10 items-center gap-2 border-b py-1.5 transition-colors duration-150 focus-within:border-primary/60',
          message ? 'border-destructive/60' : 'border-border',
        )}
      >
        <div
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
          onClick={() => inputRef.current?.focus()}
        >
          {visible.map((r) => (
            <span
              key={r.email}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/40 bg-accent py-0.5 pr-1 pl-2.5 text-xs text-accent-foreground"
            >
              <span className="truncate">{r.email}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  remove(r.email)
                }}
                aria-label={`Remove ${r.email}`}
                className="flex size-4 items-center justify-center rounded-full text-accent-foreground/70 hover:bg-primary/15 hover:text-accent-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setExpanded(true)
              }}
              className="rounded-full border border-primary/40 bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground hover:bg-primary/15"
              aria-label={`Show ${hiddenCount} more recipients`}
            >
              +{hiddenCount}
            </button>
          )}
          {expanded && value.length > COLLAPSED_LIMIT && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setExpanded(false)
              }}
              className="px-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Show less
            </button>
          )}
          <input
            ref={inputRef}
            id={id}
            type="email"
            inputMode="email"
            autoComplete="off"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              if (draftError) setDraftError(undefined)
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (['Enter', ',', ';', ' ', 'Tab'].includes(e.key) && draft.trim()) {
                if (e.key === 'Tab') {
                  if (!commitDraft()) e.preventDefault()
                } else {
                  e.preventDefault()
                  commitDraft()
                }
              } else if (e.key === 'Backspace' && !draft && value.length) {
                remove(value[value.length - 1].email)
              }
            }}
            onPaste={(e) => {
              const found = extractEmails(e.clipboardData.getData('text'))
              if (found.length > 1) {
                e.preventDefault()
                addEmails(found)
              }
            }}
            onBlur={commitDraft}
            placeholder={value.length ? '' : 'recipient@example.com'}
            aria-invalid={Boolean(message) || undefined}
            aria-describedby={message ? `${id}-error` : undefined}
            className="h-7 min-w-40 flex-1 bg-transparent text-sm text-foreground placeholder:text-subtle-foreground outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium text-primary transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
        >
          <Upload className="size-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Upload List</span>
          <span className="sr-only sm:hidden">Upload recipient list</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleListUpload(file)
            e.target.value = ''
          }}
        />
      </div>
      {message && (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs text-destructive">
          {message}
        </p>
      )}
    </div>
  )
}

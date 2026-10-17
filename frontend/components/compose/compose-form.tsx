'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { RecipientInput } from '@/components/compose/recipient-input'
import { RichTextEditor } from '@/components/compose/rich-text-editor'
import { formatScheduleLabel, SchedulePopover } from '@/components/compose/schedule-popover'
import { PageHeader } from '@/components/mail/page-header'
import { useRevalidateMail } from '@/hooks/use-mail'
import { useCurrentUser } from '@/hooks/use-mail'
import { scheduleEmail } from '@/lib/services/email-service'
import type { Recipient } from '@/lib/types'
import { cn } from '@/lib/utils'

type FieldErrors = Partial<Record<'to' | 'subject' | 'body' | 'delay' | 'hourly', string>>

function parseOptionalInt(value: string) {
  if (!value.trim()) return { value: undefined }
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) return { error: 'Use a whole number, 0 or more.' }
  return { value: n }
}

const labelClass = 'w-16 shrink-0 text-xs text-muted-foreground md:w-20'

export function ComposeForm() {
  const router = useRouter()
  const revalidateAll = useRevalidateMail()
  const { data: user } = useCurrentUser()
  const idempotencyRef = useRef<{ signature: string; key: string } | null>(null)

  const [from, setFrom] = useState('')
  const [to, setTo] = useState<Recipient[]>([])
  const [subject, setSubject] = useState('')
  const [delay, setDelay] = useState('')
  const [hourly, setHourly] = useState('')
  const [bodyHtml, setBodyHtml] = useState('')
  const [scheduledAt, setScheduledAt] = useState<Date | null>(null)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (user && !from) setFrom(user.email)
  }, [from, user])

  function clearError(field: keyof FieldErrors) {
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }))
  }

  async function handleSubmit() {
    if (submitting) return
    const delayResult = parseOptionalInt(delay)
    const hourlyResult = parseOptionalInt(hourly)
    const nextErrors: FieldErrors = {
      to: to.length === 0 ? 'Add at least one recipient.' : undefined,
      subject: subject.trim() ? undefined : 'Add a subject.',
      body: bodyHtml.replace(/<[^>]*>/g, '').trim() ? undefined : 'Add email content.',
      delay: delayResult.error,
      hourly: hourlyResult.error ?? (hourlyResult.value !== undefined && hourlyResult.value < 1
        ? 'Hourly limit must be at least 1.'
        : undefined),
    }
    setErrors(nextErrors)
    const firstError = (Object.keys(nextErrors) as (keyof FieldErrors)[]).find((k) => nextErrors[k])
    if (firstError) {
      document.getElementById(`compose-${firstError}`)?.focus()
      return
    }

    const draft = {
      from,
      to,
      subject,
      bodyHtml,
      attachments: [],
      delayBetweenSeconds: delayResult.value,
      hourlyLimit: hourlyResult.value,
    }
    const signature = JSON.stringify({ draft, scheduledAt: scheduledAt?.toISOString() ?? null })
    if (idempotencyRef.current?.signature !== signature) {
      idempotencyRef.current = { signature, key: crypto.randomUUID() }
    }

    setSubmitting(true)
    try {
      const result = await scheduleEmail(draft, {
        idempotencyKey: idempotencyRef.current.key,
        ...(scheduledAt ? { scheduledAt } : {}),
      })
      const count = result.recipients.accepted
      toast.success(
        result.replayed
          ? `This request was already accepted (${count} recipient${count === 1 ? '' : 's'}).`
          : scheduledAt
            ? `Scheduled ${count} email${count === 1 ? '' : 's'} for ${formatScheduleLabel(scheduledAt)}`
            : `Queued ${count} email${count === 1 ? '' : 's'} for delivery`,
      )
      await revalidateAll()
      router.push('/scheduled')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong. Try again.'
      const detailMessages = err && typeof err === 'object' && 'details' in err && Array.isArray(err.details)
        ? err.details.map((detail) => detail.message).filter(Boolean).join(' · ')
        : ''
      toast.error(message, detailMessages ? { description: detailMessages } : undefined)
      setSubmitting(false)
    }
  }

  const actions = (
    <>
      <SchedulePopover value={scheduledAt} onChange={setScheduledAt} />
      <button
        type="submit"
        form="compose-form"
        disabled={submitting}
        className="ml-1 flex h-8 items-center gap-1.5 rounded-full border border-primary px-4 text-xs font-medium text-primary transition-colors duration-150 outline-none hover:bg-primary hover:text-primary-foreground focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-primary"
      >
        {submitting && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
        {scheduledAt ? 'Schedule' : 'Send Later'}
      </button>
    </>
  )

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <PageHeader title="Compose New Email" fallbackHref="/scheduled" actions={actions} />

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 md:px-8 md:py-8">
        <form
          id="compose-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            handleSubmit()
          }}
          className="flex flex-col gap-4"
          aria-busy={submitting}
        >
          {scheduledAt && (
            <p className="self-start rounded-full bg-accent px-3 py-1 text-xs text-accent-foreground">
              Will send {formatScheduleLabel(scheduledAt)}
            </p>
          )}

          <div className="flex items-center gap-3">
            <span className={labelClass} id="from-label">
              From
            </span>
            <span className="text-[13px] text-foreground">{from || 'Loading account…'}</span>
          </div>

          <div className="flex items-start gap-3">
            <label htmlFor="compose-to" className={cn(labelClass, 'pt-3')}>
              To
            </label>
            <RecipientInput
              id="compose-to"
              value={to}
              onChange={setTo}
              error={errors.to}
              onClearError={() => clearError('to')}
            />
          </div>

          <div className="flex items-start gap-3">
            <label htmlFor="compose-subject" className={cn(labelClass, 'pt-2.5')}>
              Subject
            </label>
            <div className="min-w-0 flex-1">
              <input
                id="compose-subject"
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value)
                  clearError('subject')
                }}
                placeholder="Subject"
                maxLength={200}
                aria-invalid={Boolean(errors.subject) || undefined}
                aria-describedby={errors.subject ? 'compose-subject-error' : undefined}
                className={cn(
                  'h-10 w-full border-b bg-transparent text-sm text-foreground placeholder:text-subtle-foreground outline-none transition-colors focus:border-primary/60',
                  errors.subject ? 'border-destructive/60' : 'border-border',
                )}
              />
              {errors.subject && (
                <p id="compose-subject-error" role="alert" className="mt-1.5 text-xs text-destructive">
                  {errors.subject}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            <NumberField
              id="compose-delay"
              label="Delay between 2 emails"
              hint="seconds"
              value={delay}
              error={errors.delay}
              onChange={(v) => {
                setDelay(v)
                clearError('delay')
              }}
            />
            <NumberField
              id="compose-hourly"
              label="Hourly Limit"
              hint="emails / hr"
              value={hourly}
              error={errors.hourly}
              onChange={(v) => {
                setHourly(v)
                clearError('hourly')
              }}
            />
          </div>

          <RichTextEditor
            onChange={(value) => {
              setBodyHtml(value)
              clearError('body')
            }}
            placeholder="Type Your Reply..."
            onSubmitShortcut={handleSubmit}
          />
          {errors.body && <p role="alert" className="text-xs text-destructive">{errors.body}</p>}
        </form>
      </main>
    </div>
  )
}

interface NumberFieldProps {
  id: string
  label: string
  hint: string
  value: string
  error?: string
  onChange: (value: string) => void
}

function NumberField({ id, label, hint, value, error, onChange }: NumberFieldProps) {
  return (
    <div>
      <div className="flex items-center gap-2.5">
        <label htmlFor={id} className="text-xs text-muted-foreground">
          {label}
        </label>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={id === 'compose-hourly' ? 1 : 0}
          step={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="00"
          title={hint}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={cn(
            'h-8 w-16 rounded-md border bg-background px-2 text-[13px] text-foreground tabular-nums placeholder:text-subtle-foreground outline-none transition-[border-color,box-shadow] focus:border-primary/60 focus:ring-3 focus:ring-primary/10 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
            error ? 'border-destructive/60' : 'border-border',
          )}
        />
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

'use client'

import { useState } from 'react'
import { Check, Clock } from 'lucide-react'
import { headerIconButton } from '@/components/mail/page-header'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

interface SchedulePopoverProps {
  value: Date | null
  onChange: (value: Date | null) => void
}

function tomorrowAt(hour: number) {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(hour, 0, 0, 0)
  return d
}

function toLocalInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function presetLabel(date: Date) {
  return `Tomorrow, ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

export function formatScheduleLabel(date: Date) {
  return date.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function SchedulePopover({ value, onChange }: SchedulePopoverProps) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState('')
  const [error, setError] = useState<string>()

  const presets = [9, 10, 11, 15].map(tomorrowAt)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setPending(value ? toLocalInput(value) : '')
      setError(undefined)
    }
  }

  function apply() {
    if (!pending) {
      setError('Pick a date and time.')
      return
    }
    const date = new Date(pending)
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
      setError('Choose a time in the future.')
      return
    }
    onChange(date)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        className={cn(headerIconButton, value && 'text-primary hover:text-primary')}
        aria-label={value ? `Scheduled for ${formatScheduleLabel(value)}. Change schedule` : 'Schedule send'}
      >
        <Clock className="size-[18px]" />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-72 gap-0 p-0">
        <div className="px-4 pt-4 pb-3">
          <p className="text-sm font-medium text-foreground">Send Later</p>
          <label htmlFor="schedule-at" className="sr-only">
            Pick date and time
          </label>
          <input
            id="schedule-at"
            type="datetime-local"
            value={pending}
            min={toLocalInput(new Date())}
            onChange={(e) => {
              setPending(e.target.value)
              setError(undefined)
            }}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? 'schedule-error' : undefined}
            className={cn(
              'mt-3 h-9 w-full border-b bg-transparent text-xs text-foreground outline-none transition-colors [color-scheme:light] focus:border-primary',
              error ? 'border-destructive' : 'border-border',
              !pending && 'text-subtle-foreground',
            )}
          />
          {error && (
            <p id="schedule-error" role="alert" className="mt-1.5 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <ul className="px-2 pb-2" aria-label="Quick picks">
          {presets.map((date) => {
            const selected = pending === toLocalInput(date)
            return (
              <li key={date.getTime()}>
                <button
                  type="button"
                  onClick={() => {
                    setPending(toLocalInput(date))
                    setError(undefined)
                  }}
                  aria-pressed={selected}
                  className={cn(
                    'flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-xs transition-colors outline-none hover:bg-muted focus-visible:bg-muted',
                    selected ? 'text-accent-foreground' : 'text-muted-foreground',
                  )}
                >
                  {presetLabel(date)}
                  {selected && <Check className="size-3.5 text-primary" aria-hidden="true" />}
                </button>
              </li>
            )
          })}
        </ul>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          {value ? (
            <button
              type="button"
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
              className="text-xs text-muted-foreground hover:text-destructive"
            >
              Send now instead
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={apply}
              className="rounded-full border border-primary px-4 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-accent"
            >
              Done
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

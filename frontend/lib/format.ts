export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isSameDay(a: Date, b: Date) {
  return a.toDateString() === b.toDateString()
}

export function formatListTime(iso: string) {
  const date = new Date(iso)
  const now = new Date()
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (isSameDay(date, now)) return time
  const diffDays = Math.abs(date.getTime() - now.getTime()) / 86_400_000
  if (diffDays < 6) {
    return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function formatFullDate(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function initials(nameOrEmail: string) {
  const parts = nameOrEmail.split(/[\s@.]+/).filter(Boolean)
  return (parts[0]?.[0] ?? '?').toUpperCase()
}

export function displayName(recipient: { name?: string; email: string }) {
  return recipient.name ?? recipient.email
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(value: string) {
  return EMAIL_PATTERN.test(value.trim())
}

export function extractEmails(text: string) {
  const matches = text.match(/[^\s@,;"'<>]+@[^\s@,;"'<>]+\.[^\s@,;"'<>]+/g) ?? []
  return Array.from(new Set(matches.map((m) => m.toLowerCase())))
}

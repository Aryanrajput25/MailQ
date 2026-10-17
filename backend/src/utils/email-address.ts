export type EmailCheck = { ok: true; value: string } | { ok: false; reason: string }

const LOCAL_ALLOWED = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/**
 * Pragmatic address validation + normalization (trim, lowercase). Rejects whitespace, control
 * characters and anything with more than one '@', which also rules out header-injection payloads.
 * Lowercasing the local part is the near-universal convention even though RFC 5321 allows
 * case-sensitive mailboxes; this keeps de-duplication predictable.
 * Internationalized (non-ASCII) addresses are not supported.
 */
export function normalizeEmail(raw: string): EmailCheck {
  const value = raw.trim().toLowerCase()
  if (!value) return { ok: false, reason: 'Email address is empty' }
  if (value.length > 254) return { ok: false, reason: 'Email address is longer than 254 characters' }
  const parts = value.split('@')
  if (parts.length !== 2) return { ok: false, reason: 'Email address must contain exactly one "@"' }
  const [local, domain] = parts as [string, string]
  if (!local || local.length > 64) return { ok: false, reason: 'Local part must be 1-64 characters' }
  if (!LOCAL_ALLOWED.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return { ok: false, reason: 'Local part contains invalid characters or dots' }
  }
  const labels = domain.split('.')
  if (labels.length < 2 || domain.length > 253) return { ok: false, reason: 'Domain must include a top-level domain' }
  if (labels.some((l) => l.length === 0 || l.length > 63 || !LABEL.test(l))) {
    return { ok: false, reason: 'Domain contains invalid characters' }
  }
  const tld = labels[labels.length - 1] as string
  if (!/^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(tld)) return { ok: false, reason: 'Top-level domain is invalid' }
  return { ok: true, value }
}

import { describe, expect, it } from 'vitest'
import { normalizeEmail } from '../src/utils/email-address'
import { htmlToText, sanitizeEmailHtml } from '../src/utils/html'
import { jobIdForEmail, sortableId } from '../src/utils/ids'

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Jane.Doe+Tag@Example.COM ')).toEqual({ ok: true, value: 'jane.doe+tag@example.com' })
  })
  it.each([
    '',
    'plain',
    'a@b',
    '@example.com',
    'a@@example.com',
    'a b@example.com',
    'a@exa mple.com',
    '.a@example.com',
    'a..b@example.com',
    'a@-example.com',
    'a@example.c',
    'a@example.com\r\nBcc: x@y.com',
    `${'x'.repeat(65)}@example.com`,
    `a@${'x'.repeat(250)}.com`,
  ])('rejects %j', (bad) => {
    expect(normalizeEmail(bad).ok).toBe(false)
  })
})

describe('html helpers', () => {
  it('strips scripts, handlers and unsafe links but keeps formatting', () => {
    const out = sanitizeEmailHtml(
      '<p onclick="x()">Hi <b>there</b><script>alert(1)</script><a href="javascript:evil()">bad</a><a href="https://ok.example">ok</a></p>',
    )
    expect(out).not.toMatch(/script|onclick|javascript:/i)
    expect(out).toContain('<b>there</b>')
    expect(out).toContain('href="https://ok.example"')
    expect(out).toContain('rel="noopener noreferrer"')
  })
  it('derives a readable plain-text alternative', () => {
    expect(htmlToText('<p>Hello &amp; welcome</p><p>Line two<br>three</p>')).toBe('Hello & welcome\nLine two\nthree')
  })
  it('returns empty text for markup-only bodies', () => {
    expect(htmlToText('<p><br></p><div> </div>')).toBe('')
  })
})

describe('ids', () => {
  it('sorts ids of one batch in input order and is unique', () => {
    const now = Date.now()
    const ids = Array.from({ length: 2000 }, (_, i) => sortableId('eml', i, now))
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('builds BullMQ-safe job ids (no colon)', () => {
    expect(jobIdForEmail('eml_abc')).toBe('email_eml_abc')
    expect(jobIdForEmail('eml_abc')).not.toContain(':')
  })
})

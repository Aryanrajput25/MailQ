import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config/env'

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'a'.repeat(32),
  TOKEN_ENCRYPTION_KEY: 'b'.repeat(32),
}

function issuesOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env as NodeJS.ProcessEnv)
  } catch (e) {
    if (e instanceof ConfigError) return e.issues
    throw e
  }
  return []
}

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const c = loadConfig(base as NodeJS.ProcessEnv)
    expect(c.PORT).toBe(4000)
    expect(c.WORKER_CONCURRENCY).toBe(5)
    expect(c.MIN_DELAY_MS).toBe(2000)
    expect(c.MAX_EMAILS_PER_HOUR).toBe(200)
    expect(c.MAX_EMAILS_PER_HOUR_PER_SENDER).toBe(100)
    expect(c.MAX_RECIPIENTS_PER_BATCH).toBe(1000)
    expect(c.google).toBeNull()
    expect(c.slack).toBeNull()
    expect(c.ethereal).toBeNull()
  })

  it('defaults and bounds the delivery-recovery settings', () => {
    const c = loadConfig(base as NodeJS.ProcessEnv)
    expect(c.STALE_PROCESSING_MS).toBe(300_000)
    expect(c.SMTP_TIMEOUT_MS).toBe(20_000)
    expect(c.EMAIL_JOB_ATTEMPTS).toBe(3)
    expect(issuesOf({ ...base, STALE_PROCESSING_MS: '10' }).join()).toMatch(/STALE_PROCESSING_MS/)
    expect(issuesOf({ ...base, SMTP_TIMEOUT_MS: '0' }).join()).toMatch(/SMTP_TIMEOUT_MS/)
  })

  it('accepts MIN_DELAY_MS=0 (throttle disabled) and rejects negative values', () => {
    expect(loadConfig({ ...base, MIN_DELAY_MS: '0' } as NodeJS.ProcessEnv).MIN_DELAY_MS).toBe(0)
    expect(issuesOf({ ...base, MIN_DELAY_MS: '-1' }).join()).toMatch(/MIN_DELAY_MS/)
  })

  it('treats blank optional values (as in .env.local) as unset', () => {
    const c = loadConfig({ ...base, GOOGLE_CLIENT_ID: '', ETHEREAL_PORT: '', SLACK_REDIRECT_URI: '' } as NodeJS.ProcessEnv)
    expect(c.google).toBeNull()
    expect(c.ethereal).toBeNull()
  })

  it('reports every missing required value at once', () => {
    const issues = issuesOf({})
    expect(issues.join('\n')).toMatch(/DATABASE_URL/)
    expect(issues.join('\n')).toMatch(/REDIS_URL/)
    expect(issues.join('\n')).toMatch(/SESSION_SECRET/)
    expect(issues.join('\n')).toMatch(/TOKEN_ENCRYPTION_KEY/)
  })

  it('rejects short secrets', () => {
    expect(issuesOf({ ...base, SESSION_SECRET: 'short' }).join()).toMatch(/SESSION_SECRET/)
  })

  it('rejects a partially configured OAuth group', () => {
    const issues = issuesOf({ ...base, GOOGLE_CLIENT_ID: 'id' })
    expect(issues.join()).toMatch(/Google OAuth is partially configured/)
  })

  it('rejects per-sender limit above the global limit', () => {
    const issues = issuesOf({ ...base, MAX_EMAILS_PER_HOUR: '50', MAX_EMAILS_PER_HOUR_PER_SENDER: '100' })
    expect(issues.join()).toMatch(/cannot exceed/)
  })

  it('rejects out-of-range numbers', () => {
    expect(issuesOf({ ...base, WORKER_CONCURRENCY: '0' }).join()).toMatch(/WORKER_CONCURRENCY/)
    expect(issuesOf({ ...base, PORT: 'abc' }).join()).toMatch(/PORT/)
  })

  it('requires Google, Ethereal and an explicit Bull Board administrator in production', () => {
    const issues = issuesOf({ ...base, NODE_ENV: 'production' }).join('\n')
    expect(issues).toMatch(/Google OAuth must be configured/)
    expect(issues).toMatch(/Ethereal SMTP credentials/)
    expect(issues).toMatch(/BULL_BOARD_ADMIN_EMAILS/)
  })

  it('normalizes and validates the Bull Board administrator allowlist', () => {
    const config = loadConfig({
      ...base,
      BULL_BOARD_ADMIN_EMAILS: ' Admin@Example.com,ops@example.com,admin@example.com ',
    } as NodeJS.ProcessEnv)
    expect(config.bullBoardAdminEmails).toEqual(['admin@example.com', 'ops@example.com'])
    expect(issuesOf({ ...base, BULL_BOARD_ADMIN_EMAILS: 'admin,not-an-email@example' }).join())
      .toMatch(/BULL_BOARD_ADMIN_EMAILS must be a comma-separated list of valid email addresses/)
  })

  it('builds typed integration groups when complete', () => {
    const c = loadConfig({
      ...base,
      GOOGLE_CLIENT_ID: 'gid',
      GOOGLE_CLIENT_SECRET: 'gsecret',
      GOOGLE_CALLBACK_URL: 'http://localhost:4000/api/auth/google/callback',
      ETHEREAL_HOST: 'smtp.ethereal.email',
      ETHEREAL_PORT: '587',
      ETHEREAL_USER: 'u',
      ETHEREAL_PASS: 'p',
    } as NodeJS.ProcessEnv)
    expect(c.google?.clientId).toBe('gid')
    expect(c.ethereal?.port).toBe(587)
  })

  it('accepts a fully configured Slack OAuth group', () => {
    const c = loadConfig({
      ...base,
      SLACK_CLIENT_ID: 'sid',
      SLACK_CLIENT_SECRET: 'ssecret',
      SLACK_REDIRECT_URI: 'http://localhost:4000/api/slack/callback',
    } as NodeJS.ProcessEnv)
    expect(c.slack).toEqual({
      clientId: 'sid',
      clientSecret: 'ssecret',
      redirectUri: 'http://localhost:4000/api/slack/callback',
    })
  })
})

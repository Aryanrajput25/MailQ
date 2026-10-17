import { z } from 'zod'

const int = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def)

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)
const optStr = z.preprocess(blankToUndefined, z.string().optional())
const optUrl = z.preprocess(blankToUndefined, z.string().url().optional())

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000, 1, 65535),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  ELASTICSEARCH_URL: z.string().url().default('http://localhost:9200'),
  ELASTICSEARCH_API_KEY: optStr,

  GOOGLE_CLIENT_ID: optStr,
  GOOGLE_CLIENT_SECRET: optStr,
  GOOGLE_CALLBACK_URL: optUrl,

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(32, 'TOKEN_ENCRYPTION_KEY must be at least 32 characters (use `openssl rand -hex 32`)'),

  ETHEREAL_HOST: optStr,
  ETHEREAL_PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).optional()),
  ETHEREAL_USER: optStr,
  ETHEREAL_PASS: optStr,

  WORKER_CONCURRENCY: int(5, 1, 100),
  MIN_DELAY_MS: int(2000, 0, 3_600_000),
  MAX_EMAILS_PER_HOUR: int(200, 1, 1_000_000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: int(100, 1, 1_000_000),
  MAX_RECIPIENTS_PER_BATCH: int(1000, 1, 100_000),
  EMAIL_JOB_ATTEMPTS: int(3, 1, 20),
  // A 'processing' row older than this is treated as abandoned by a crashed worker.
  STALE_PROCESSING_MS: int(300_000, 30_000, 86_400_000),
  // Connection / greeting / socket timeout for SMTP.
  SMTP_TIMEOUT_MS: int(20_000, 1_000, 300_000),
  EMAIL_JOB_BACKOFF_MS: int(5000, 100, 3_600_000),

  SLACK_CLIENT_ID: optStr,
  SLACK_CLIENT_SECRET: optStr,
  SLACK_REDIRECT_URI: optUrl,

  BULL_BOARD_ADMIN_EMAILS: optStr,
})

type Raw = z.infer<typeof schema>

export interface Config extends Raw {
  isProduction: boolean
  google: { clientId: string; clientSecret: string; callbackUrl: string } | null
  slack: { clientId: string; clientSecret: string; redirectUri: string } | null
  ethereal: { host: string; port: number; user: string; pass: string } | null
  bullBoardAdminEmails: string[]
}

/** Groups of settings that must be provided together (or not at all). */
function groupOrNothing(name: string, entries: Record<string, unknown>, issues: string[]): boolean {
  const set = Object.entries(entries).filter(([, v]) => v !== undefined)
  if (set.length === 0) return false
  if (set.length !== Object.keys(entries).length) {
    const missing = Object.keys(entries).filter((k) => entries[k] === undefined)
    issues.push(`${name} is partially configured; also set: ${missing.join(', ')}`)
    return false
  }
  return true
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n - ${issues.join('\n - ')}`)
    this.name = 'ConfigError'
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  }
  const env = parsed.data
  const issues: string[] = []

  const google = groupOrNothing(
    'Google OAuth',
    {
      GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
      GOOGLE_CALLBACK_URL: env.GOOGLE_CALLBACK_URL,
    },
    issues,
  )
  const slack = groupOrNothing(
    'Slack OAuth',
    {
      SLACK_CLIENT_ID: env.SLACK_CLIENT_ID,
      SLACK_CLIENT_SECRET: env.SLACK_CLIENT_SECRET,
      SLACK_REDIRECT_URI: env.SLACK_REDIRECT_URI,
    },
    issues,
  )
  const ethereal = groupOrNothing(
    'Ethereal SMTP',
    {
      ETHEREAL_HOST: env.ETHEREAL_HOST,
      ETHEREAL_PORT: env.ETHEREAL_PORT,
      ETHEREAL_USER: env.ETHEREAL_USER,
      ETHEREAL_PASS: env.ETHEREAL_PASS,
    },
    issues,
  )

  const bullBoardAdminEmails = env.BULL_BOARD_ADMIN_EMAILS
    ? env.BULL_BOARD_ADMIN_EMAILS.split(',').map((email) => email.trim().toLowerCase())
    : []
  if (bullBoardAdminEmails.some((email) => !z.string().email().safeParse(email).success)) {
    issues.push('BULL_BOARD_ADMIN_EMAILS must be a comma-separated list of valid email addresses')
  }
  const uniqueBullBoardAdminEmails = [...new Set(bullBoardAdminEmails)]

  const isProduction = env.NODE_ENV === 'production'
  if (isProduction && !google) issues.push('Google OAuth must be configured in production')
  if (isProduction && !ethereal) {
    issues.push('Ethereal SMTP credentials must be configured in production (auto-create is dev-only)')
  }
  if (isProduction && uniqueBullBoardAdminEmails.length === 0) {
    issues.push('BULL_BOARD_ADMIN_EMAILS must identify at least one administrator in production')
  }
  if (env.MAX_EMAILS_PER_HOUR_PER_SENDER > env.MAX_EMAILS_PER_HOUR) {
    issues.push('MAX_EMAILS_PER_HOUR_PER_SENDER cannot exceed MAX_EMAILS_PER_HOUR')
  }
  if (issues.length) throw new ConfigError(issues)

  return {
    ...env,
    isProduction,
    bullBoardAdminEmails: uniqueBullBoardAdminEmails,
    google: google
      ? {
          clientId: env.GOOGLE_CLIENT_ID!,
          clientSecret: env.GOOGLE_CLIENT_SECRET!,
          callbackUrl: env.GOOGLE_CALLBACK_URL!,
        }
      : null,
    slack: slack
      ? {
          clientId: env.SLACK_CLIENT_ID!,
          clientSecret: env.SLACK_CLIENT_SECRET!,
          redirectUri: env.SLACK_REDIRECT_URI!,
        }
      : null,
    ethereal: ethereal
      ? {
          host: env.ETHEREAL_HOST!,
          port: env.ETHEREAL_PORT!,
          user: env.ETHEREAL_USER!,
          pass: env.ETHEREAL_PASS!,
        }
      : null,
  }
}

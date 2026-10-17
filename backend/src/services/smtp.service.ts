import nodemailer, { type SentMessageInfo, type Transporter } from 'nodemailer'
import { logger } from '../utils/logger'

export interface SmtpMessage {
  emailId: string
  from: { address: string; name?: string | null }
  to: string
  subject: string
  html: string
  text: string
}

export interface SmtpReceipt {
  messageId: string
  /** Ethereal-only: URL where the captured message can be opened. Null for other providers. */
  previewUrl: string | null
}

/** The only thing the worker needs from SMTP. Tests substitute this. */
export interface DeliveryPort {
  send(message: SmtpMessage): Promise<SmtpReceipt>
}

/**
 * transient  - the server definitely did NOT accept the message (connect/auth-phase network failure,
 *              4xx reply). Safe to retry with backoff.
 * permanent  - the server definitively rejected it (5xx, bad credentials, rejected recipient). Never retried.
 * uncertain  - the connection failed after the message body was sent, so the server MAY have accepted it.
 *              Retrying could duplicate a delivered message, so it is NOT retried automatically.
 */
export type FailureKind = 'transient' | 'permanent' | 'uncertain'

export class SmtpDeliveryError extends Error {
  constructor(
    message: string,
    public readonly kind: FailureKind,
    public readonly code?: string,
    public readonly responseCode?: number,
  ) {
    super(message)
    this.name = 'SmtpDeliveryError'
  }
}

export interface SmtpCredentials {
  host: string
  port: number
  user: string
  pass: string
  /** Defaults to port === 465. */
  secure?: boolean
  /** Test servers only: never negotiate STARTTLS. */
  ignoreTls?: boolean
}

export interface SmtpServiceOptions {
  /** Explicit credentials (Ethereal or any SMTP). When null, auto-creation must be allowed. */
  credentials: SmtpCredentials | null
  /** Development only: create a throwaway Ethereal account on first use. */
  allowAutoCreate: boolean
  timeoutMs: number
  createTestAccount?: typeof nodemailer.createTestAccount
}

/** Deterministic Message-ID: a retry or a duplicate job reuses the same id, so duplicates are detectable. */
export function messageIdFor(emailId: string): string {
  return `<${emailId}@reachinbox.local>`
}

// Failures that can only happen before any connection exists, so nothing can have been delivered.
const NEVER_CONNECTED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EDNS', 'EHOSTUNREACH', 'ENETUNREACH'])

export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text
  for (const secret of secrets) if (secret && secret.length >= 3) out = out.split(secret).join('[redacted]')
  return out.slice(0, 500)
}

/**
 * Tracks how far a single send got. Nodemailer reports `command: "CONN"` even for timeouts and resets
 * that happen AFTER the message body was transmitted, so the error itself cannot tell us whether the
 * server may have accepted the message. We observe it directly: the body stream is only consumed once
 * the server has answered `354` to DATA.
 */
export interface SendPhase {
  /** True once the MIME hook was attached for this send. If false we cannot prove anything. */
  hooked: boolean
  /** True once the message body started flowing to the server (DATA accepted). */
  bodyStarted: boolean
}

/** Maps any Nodemailer/network error to a retry policy. Exported for direct testing. */
export function classifySmtpError(err: unknown, secrets: Array<string | undefined> = [], phase?: SendPhase): SmtpDeliveryError {
  if (err instanceof SmtpDeliveryError) return err
  const e = (err ?? {}) as { code?: string; responseCode?: number; message?: string }
  const message = redact(typeof e.message === 'string' && e.message ? e.message : 'SMTP error', secrets)
  const rc = typeof e.responseCode === 'number' ? e.responseCode : undefined

  if (rc !== undefined) {
    // The server answered, so we know exactly what it decided about the message.
    if (rc >= 400 && rc < 500) return new SmtpDeliveryError(message, 'transient', e.code, rc)
    if (rc >= 500 && rc < 600) return new SmtpDeliveryError(message, 'permanent', e.code, rc)
  }
  if (e.code === 'EAUTH' || e.code === 'EENVELOPE' || e.code === 'EMESSAGE') {
    return new SmtpDeliveryError(message, 'permanent', e.code, rc)
  }
  if (e.code && NEVER_CONNECTED_CODES.has(e.code)) return new SmtpDeliveryError(message, 'transient', e.code, rc)

  // Everything else (timeouts, resets, unknown errors): safe to retry ONLY if we can prove the body was not sent.
  const provablyBeforeBody = phase?.hooked === true && phase.bodyStarted === false
  return new SmtpDeliveryError(message, provablyBeforeBody ? 'transient' : 'uncertain', e.code, rc)
}

export function previewUrlFor(info: Pick<SentMessageInfo, 'response'> & Record<string, unknown>, host: string): string | null {
  const viaNodemailer = nodemailer.getTestMessageUrl(info as SentMessageInfo)
  if (typeof viaNodemailer === 'string') return viaNodemailer
  if (host.endsWith('ethereal.email')) {
    const match = /\[STATUSID ([^\]]+)\]/.exec(String(info.response ?? ''))
    if (match?.[1]) return `https://ethereal.email/message/${match[1]}`
  }
  return null
}

export class SmtpService implements DeliveryPort {
  private transport?: Promise<{ transporter: Transporter; host: string; secrets: string[] }>

  constructor(private readonly options: SmtpServiceOptions) {
    if (!options.credentials && !options.allowAutoCreate) {
      throw new Error('SMTP is not configured: set ETHEREAL_* credentials (auto-creation is development-only)')
    }
  }

  private getTransport() {
    // Cache only successes: a failed auto-creation (network blip) must be retried next time.
    this.transport ??= this.createTransport().catch((err) => {
      this.transport = undefined
      throw err
    })
    return this.transport
  }

  private async createTransport() {
    let creds = this.options.credentials
    if (!creds) {
      const create = this.options.createTestAccount ?? nodemailer.createTestAccount.bind(nodemailer)
      const account = await create()
      creds = { host: account.smtp.host, port: account.smtp.port, user: account.user, pass: account.pass, secure: account.smtp.secure }
      // Log where mail goes, never the secret. The user is a throwaway identifier but still omitted.
      logger.info({ host: creds.host, port: creds.port }, 'created a development Ethereal SMTP account')
    }
    const t = this.options.timeoutMs
    const transporter = nodemailer.createTransport({
      host: creds.host,
      port: creds.port,
      secure: creds.secure ?? creds.port === 465,
      ...(creds.ignoreTls ? { ignoreTLS: true } : {}),
      auth: { user: creds.user, pass: creds.pass },
      connectionTimeout: t,
      greetingTimeout: t,
      socketTimeout: t,
      dnsTimeout: t,
    })
    // Observe when the body starts flowing (see SendPhase). The phase object travels in the mail options.
    transporter.use('stream', (mail, done) => {
      const phase = (mail.data as { reachinboxPhase?: SendPhase }).reachinboxPhase
      const message = mail.message as unknown as { createReadStream: () => NodeJS.ReadableStream }
      if (phase && typeof message.createReadStream === 'function') {
        const original = message.createReadStream.bind(message)
        message.createReadStream = () => {
          const stream = original()
          stream.on('newListener', (event: string) => {
            if (event === 'data' || event === 'readable') phase.bodyStarted = true // pipe() attached after DATA 354
          })
          return stream
        }
        phase.hooked = true
      }
      done()
    })
    return { transporter, host: creds.host, secrets: [creds.pass, creds.user] }
  }

  /** Checks connectivity and credentials. Throws a classified SmtpDeliveryError. */
  async verify(): Promise<void> {
    let ctx
    try {
      ctx = await this.getTransport()
      await ctx.transporter.verify()
    } catch (err) {
      throw classifySmtpError(err, ctx?.secrets)
    }
  }

  async send(message: SmtpMessage): Promise<SmtpReceipt> {
    let ctx
    try {
      ctx = await this.getTransport()
    } catch (err) {
      // Could not even obtain a transport (e.g. Ethereal account creation failed): nothing was sent.
      throw new SmtpDeliveryError(redact(err instanceof Error ? err.message : 'SMTP transport unavailable', []), 'transient')
    }
    const phase: SendPhase = { hooked: false, bodyStarted: false }
    try {
      const info = await ctx.transporter.sendMail({
        reachinboxPhase: phase,
        from: { name: message.from.name ?? '', address: message.from.address },
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        messageId: messageIdFor(message.emailId),
        headers: { 'X-ReachInbox-Email-Id': message.emailId },
      } as Parameters<Transporter['sendMail']>[0])
      if (!info.accepted?.length || info.rejected?.length) {
        throw new SmtpDeliveryError('The SMTP server rejected the recipient', 'permanent', 'EENVELOPE')
      }
      return { messageId: info.messageId ?? messageIdFor(message.emailId), previewUrl: previewUrlFor(info as never, ctx.host) }
    } catch (err) {
      throw classifySmtpError(err, ctx.secrets, phase)
    }
  }
}

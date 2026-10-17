import { simpleParser, type ParsedMail } from 'mailparser'
import { SMTPServer } from 'smtp-server'
import type { AddressInfo } from 'node:net'

export type Behavior =
  | { kind: 'accept' }
  | { kind: 'reject-rcpt'; code: number }
  | { kind: 'reject-data'; code: number }
  | { kind: 'hang-after-data' } // read the whole body, then never answer
  | { kind: 'drop-after-data' } // read the whole body, then kill the socket

export interface Received {
  at: number
  mail: ParsedMail
  from: string
  to: string[]
}

/** A real SMTP protocol server on localhost for tests (no network access needed). */
export async function startSmtpServer(opts: { user?: string; pass?: string; greetingDelayMs?: number; acceptDelayMs?: number } = {}) {
  const user = opts.user ?? 'tester'
  const pass = opts.pass ?? 'S3cr3t-Pass!'
  const received: Received[] = []
  const attempts: Array<{ at: number; behavior: string }> = []
  let behavior: (n: number) => Behavior = () => ({ kind: 'accept' })
  let counter = 0
  const stats = { rcptCalls: 0 }

  const server = new SMTPServer({
    authOptional: false,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    logger: false,
    onConnect(_session, cb) {
      if (opts.greetingDelayMs) setTimeout(() => cb(), opts.greetingDelayMs)
      else cb()
    },
    onAuth(auth, _session, cb) {
      if (auth.username === user && auth.password === pass) return cb(null, { user })
      cb(Object.assign(new Error('Invalid credentials'), { responseCode: 535 }))
    },
    onMailFrom(address, session, cb) {
      ;(session as unknown as { n: number }).n = ++counter
      cb()
    },
    onRcptTo(address, session, cb) {
      stats.rcptCalls++
      const b = behavior((session as unknown as { n: number }).n)
      if (b.kind === 'reject-rcpt') return cb(Object.assign(new Error('Mailbox unavailable'), { responseCode: b.code }))
      cb()
    },
    onData(stream, session, cb) {
      const n = (session as unknown as { n: number }).n
      const b = behavior(n)
      attempts.push({ at: Date.now(), behavior: b.kind })
      const chunks: Buffer[] = []
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', async () => {
        if (b.kind === 'hang-after-data') return // never call cb
        if (b.kind === 'drop-after-data') {
          for (const conn of (server as unknown as { connections: Set<{ _socket: { destroy(): void } }> }).connections) conn._socket.destroy()
          return
        }
        if (b.kind === 'reject-data') return cb(Object.assign(new Error('Try again later'), { responseCode: b.code }))
        const mail = await simpleParser(Buffer.concat(chunks))
        received.push({
          at: Date.now(),
          mail,
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
        })
        if (opts.acceptDelayMs) await new Promise((r) => setTimeout(r, opts.acceptDelayMs))
        cb(null, 'OK queued')
      })
    },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.server.address() as AddressInfo).port
  return {
    port,
    user,
    pass,
    received,
    attempts,
    stats,
    setBehavior(fn: (n: number) => Behavior) {
      behavior = fn
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    credentials: { host: '127.0.0.1', port, user, pass, secure: false, ignoreTls: true },
  }
}

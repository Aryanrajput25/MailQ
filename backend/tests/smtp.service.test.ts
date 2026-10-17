import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SmtpDeliveryError, SmtpService, classifySmtpError, messageIdFor, previewUrlFor, redact } from '../src/services/smtp.service'
import { startSmtpServer } from './helpers/smtp-server'

const msg = (over: Record<string, unknown> = {}) => ({
  emailId: 'eml_test1',
  from: { address: 'oliver.brown@domain.io', name: 'Oliver Brown' },
  to: 'recipient@example.com',
  subject: 'Quarterly update',
  html: '<p>Hello <b>there</b></p>',
  text: 'Hello there',
  ...over,
})

describe('classifySmtpError (pure)', () => {
  const before = { hooked: true, bodyStarted: false }
  const after = { hooked: true, bodyStarted: true }
  it.each([
    ['421 reply', { responseCode: 421, message: 'busy' }, undefined, 'transient'],
    ['451 after DATA', { responseCode: 451, message: 'greylisted', command: 'DATA' }, after, 'transient'],
    ['550 reply', { responseCode: 550, message: 'no such user' }, undefined, 'permanent'],
    ['554 after DATA', { responseCode: 554, message: 'rejected', command: 'DATA' }, after, 'permanent'],
    ['bad credentials', { code: 'EAUTH', message: 'bad login' }, before, 'permanent'],
    ['bad envelope', { code: 'EENVELOPE', message: 'bad rcpt' }, before, 'permanent'],
    ['connection refused', { code: 'ECONNREFUSED', command: 'CONN', message: 'refused' }, undefined, 'transient'],
    ['DNS failure', { code: 'ENOTFOUND', message: 'dns' }, undefined, 'transient'],
    ['timeout before body (proven)', { code: 'ETIMEDOUT', command: 'CONN', message: 'Timeout' }, before, 'transient'],
    ['timeout after body started', { code: 'ETIMEDOUT', command: 'CONN', message: 'Timeout' }, after, 'uncertain'],
    ['reset after body started', { code: 'ECONNRESET', message: 'reset' }, after, 'uncertain'],
    ['closed after body started', { code: 'ECONNECTION', command: 'CONN', message: 'closed' }, after, 'uncertain'],
    ['timeout with NO phase info (cannot prove)', { code: 'ETIMEDOUT', command: 'CONN', message: 'Timeout' }, undefined, 'uncertain'],
    ['timeout with hook not attached', { code: 'ETIMEDOUT', message: 'Timeout' }, { hooked: false, bodyStarted: false }, 'uncertain'],
    ['unknown error, body started', { message: 'weird' }, after, 'uncertain'],
    ['unknown error, provably before body', { message: 'weird' }, before, 'transient'],
  ])('%s -> %s', (_name, err, phase, kind) => {
    expect(classifySmtpError(err, [], phase as never).kind).toBe(kind)
  })

  it('redacts credentials from messages', () => {
    const err = classifySmtpError({ message: 'login failed for tester with S3cr3t-Pass!', code: 'EAUTH' }, ['S3cr3t-Pass!', 'tester'])
    expect(err.message).not.toContain('S3cr3t-Pass!')
    expect(err.message).not.toContain('tester')
    expect(redact('abc secret xyz', ['secret'])).toBe('abc [redacted] xyz')
  })

  it('builds deterministic message ids and Ethereal preview URLs', () => {
    expect(messageIdFor('eml_1')).toBe('<eml_1@reachinbox.local>')
    expect(previewUrlFor({ response: '250 Accepted [STATUSID abc123]' }, 'smtp.ethereal.email')).toBe('https://ethereal.email/message/abc123')
    expect(previewUrlFor({ response: '250 Accepted [STATUSID abc123]' }, 'smtp.example.com')).toBeNull()
  })
})

describe('SmtpService configuration', () => {
  it('refuses to start without credentials unless auto-creation is allowed (production behaviour)', () => {
    expect(() => new SmtpService({ credentials: null, allowAutoCreate: false, timeoutMs: 1000 })).toThrow(/not configured/)
  })

  it('auto-creates a development account only when allowed, and delivers through it', async () => {
    const server = await startSmtpServer()
    let created = 0
    const svc = new SmtpService({
      credentials: null,
      allowAutoCreate: true,
      timeoutMs: 3000,
      createTestAccount: (async () => {
        created++
        return { user: server.user, pass: server.pass, smtp: { host: '127.0.0.1', port: server.port, secure: false } } as never
      }) as never,
    })
    // ignoreTLS is not part of Ethereal accounts; the local server disables STARTTLS so this still works.
    await svc.send(msg())
    await svc.send(msg({ emailId: 'eml_test2' }))
    expect(created).toBe(1) // account is created once and cached
    expect(server.received).toHaveLength(2)
    await server.close()
  })

  it('a failed auto-creation is transient and is retried on the next send', async () => {
    let calls = 0
    const svc = new SmtpService({
      credentials: null,
      allowAutoCreate: true,
      timeoutMs: 1000,
      createTestAccount: (async () => {
        calls++
        throw new Error('network down')
      }) as never,
    })
    await expect(svc.send(msg())).rejects.toMatchObject({ kind: 'transient' })
    await expect(svc.send(msg())).rejects.toMatchObject({ kind: 'transient' })
    expect(calls).toBe(2)
  })
})

describe('SmtpService against a real SMTP protocol server', () => {
  let server: Awaited<ReturnType<typeof startSmtpServer>>
  const svc = (over: Record<string, unknown> = {}, creds = {}) =>
    new SmtpService({ credentials: { ...server.credentials, ...creds }, allowAutoCreate: false, timeoutMs: 1500, ...over })

  beforeAll(async () => {
    server = await startSmtpServer()
  })
  afterAll(async () => {
    await server.close()
  })

  it('delivers sender, recipient, subject, HTML and plain-text parts exactly', async () => {
    server.received.length = 0
    const receipt = await svc().send(msg())
    expect(receipt.messageId).toBe('<eml_test1@reachinbox.local>')
    expect(receipt.previewUrl).toBeNull() // not an Ethereal host
    const got = server.received[0]!
    expect(got.from).toBe('oliver.brown@domain.io') // the UI's sender address is accepted as-is
    expect(got.to).toEqual(['recipient@example.com'])
    expect(got.mail.subject).toBe('Quarterly update')
    expect(got.mail.html).toContain('<b>there</b>')
    expect(got.mail.text?.trim()).toBe('Hello there')
    expect(got.mail.from?.value[0]).toMatchObject({ address: 'oliver.brown@domain.io', name: 'Oliver Brown' })
    expect(got.mail.messageId).toBe('<eml_test1@reachinbox.local>')
    expect(got.mail.headers.get('x-reachinbox-email-id')).toBe('eml_test1')
  })

  it('verify() succeeds with valid credentials and fails permanently with bad ones', async () => {
    await expect(svc().verify()).resolves.toBeUndefined()
    await expect(svc({}, { pass: 'wrong-password' }).verify()).rejects.toMatchObject({ kind: 'permanent', code: 'EAUTH' })
  })

  it('classifies an authentication failure as permanent and never leaks the password', async () => {
    const bad = svc({}, { pass: 'Wr0ng-Pass-Value' })
    const err = (await bad.send(msg()).catch((e) => e)) as SmtpDeliveryError
    expect(err).toBeInstanceOf(SmtpDeliveryError)
    expect(err.kind).toBe('permanent')
    expect(JSON.stringify({ m: err.message, s: err.stack })).not.toContain('Wr0ng-Pass-Value')
  })

  it('classifies a 550 recipient rejection as permanent', async () => {
    server.setBehavior(() => ({ kind: 'reject-rcpt', code: 550 }))
    await expect(svc().send(msg())).rejects.toMatchObject({ kind: 'permanent' })
  })

  it('classifies a 451 reply after the body as transient (server explicitly refused it)', async () => {
    server.setBehavior(() => ({ kind: 'reject-data', code: 451 }))
    await expect(svc().send(msg())).rejects.toMatchObject({ kind: 'transient', responseCode: 451 })
  })

  it('classifies a refused connection as transient', async () => {
    const dead = new SmtpService({ credentials: { ...server.credentials, port: 1 }, allowAutoCreate: false, timeoutMs: 1000 })
    await expect(dead.send(msg())).rejects.toMatchObject({ kind: 'transient' })
  })

  it('classifies a timeout while the body is in flight as UNCERTAIN (server may have accepted it)', async () => {
    server.setBehavior(() => ({ kind: 'hang-after-data' }))
    const err = (await svc({ timeoutMs: 700 }).send(msg()).catch((e) => e)) as SmtpDeliveryError
    expect(err.kind).toBe('uncertain')
    expect(err.code).toBe('ETIMEDOUT')
  })

  it('classifies a dropped connection after the body as UNCERTAIN', async () => {
    server.setBehavior(() => ({ kind: 'drop-after-data' }))
    const err = (await svc().send(msg()).catch((e) => e)) as SmtpDeliveryError
    expect(err.kind).toBe('uncertain')
  })

  it('classifies a greeting timeout (nothing sent yet) as transient', async () => {
    const slow = await startSmtpServer({ greetingDelayMs: 2500 })
    const s = new SmtpService({ credentials: slow.credentials, allowAutoCreate: false, timeoutMs: 600 })
    await expect(s.send(msg())).rejects.toMatchObject({ kind: 'transient' })
    await slow.close()
  })
})

import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { Redis } from 'ioredis'
import request from 'supertest'
import { DelayedError } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import type { AuthService } from '../src/services/auth.service'
import { SlackService } from '../src/services/slack.service'
import type { Config } from '../src/config/env'
import { AppError } from '../src/utils/errors'
import { createEmailProcessor, type ProcessableJob } from '../src/workers/email.processor'

const encryptionSecret = 'slack-test-encryption-secret-32-characters'
const slackConfig: NonNullable<Config['slack']> = {
  clientId: 'slack-client-id',
  clientSecret: 'slack-client-secret',
  redirectUri: 'http://localhost:4000/api/slack/callback',
}
const testUser = { id: 'user-1', email: 'user@example.com', name: 'User' }
const hourlyEvent = {
  ownerId: testUser.id,
  senderId: 'sender-1',
  senderEmail: 'sender@example.com',
  scope: 'sender' as const,
  window: 500,
}

function fakeRedis() {
  const values = new Map<string, string>()
  const redis = {
    values,
    exists: vi.fn(async (key: string) => Number(values.has(key))),
    getdel: vi.fn(async (key: string) => {
      const value = values.get(key) ?? null
      values.delete(key)
      return value
    }),
    set: vi.fn(async (key: string, value: string, ...args: (string | number)[]) => {
      if (args.includes('NX') && values.has(key)) return null
      values.set(key, value)
      return 'OK'
    }),
    eval: vi.fn(async (_script: string, _numberOfKeys: number, key: string, value: string) => {
      if (values.get(key) === value) return values.delete(key) ? 1 : 0
      return 0
    }),
  }
  return redis
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers })
}

function connectedRow(overrides: Record<string, unknown> = {}) {
  return {
    encryptedAccessToken: 'invalid-until-oauth',
    teamId: 'team-1',
    channelId: 'channel-1',
    channelName: '#ops',
    teamName: 'ReachInbox',
    revokedAt: null,
    ...overrides,
  }
}

describe('Slack OAuth and integration', () => {
  it('starts a Slack OAuth flow with state bound to the signed-in owner', async () => {
    const redis = fakeRedis()
    const service = new SlackService({} as never, redis as unknown as Redis, slackConfig, encryptionSecret)
    const url = new URL(await service.beginConnect(testUser))
    expect(url.origin).toBe('https://slack.com')
    expect(url.pathname).toBe('/oauth/v2/authorize')
    expect(url.searchParams.get('scope')).toContain('chat:write')
    expect(url.searchParams.get('scope')).toContain('incoming-webhook')
    const state = url.searchParams.get('state')!
    expect(JSON.parse(redis.values.get(`slack-oauth-state:${state}`)!)).toEqual({ ownerId: testUser.id })
  })

  it('exchanges and validates OAuth response, then stores an encrypted owner-scoped token', async () => {
    const redis = fakeRedis()
    const upsert = vi.fn(async (_args: { where: { ownerId: string }; create: Record<string, unknown> }) => ({}))
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ok: true,
        access_token: 'xoxb-live-token',
        team: { id: 'team-1', name: 'ReachInbox' },
        bot_user_id: 'bot-1',
        incoming_webhook: { channel_id: 'channel-1', channel: '#ops' },
      }),
    )
    const service = new SlackService(
      { slackConnection: { upsert } } as never,
      redis as unknown as Redis,
      slackConfig,
      encryptionSecret,
      fetchImpl,
    )
    const url = new URL(await service.beginConnect(testUser))
    const state = url.searchParams.get('state')!
    await service.completeConnect(testUser, 'oauth-code', state)
    const saved = upsert.mock.calls[0]?.[0] as { where: unknown; create: Record<string, unknown> }
    expect(saved.where).toEqual({ ownerId: testUser.id })
    expect(saved.create).toMatchObject({ ownerId: testUser.id, teamId: 'team-1', channelId: 'channel-1' })
    expect(saved.create.encryptedAccessToken).not.toContain('xoxb-live-token')
    expect(String(saved.create.encryptedAccessToken).split('.')).toHaveLength(3)
    expect(redis.values.has(`slack-oauth-state:${state}`)).toBe(false)
  })

  it('rejects invalid, replayed and cross-owner OAuth states', async () => {
    const redis = fakeRedis()
    const service = new SlackService({} as never, redis as unknown as Redis, slackConfig, encryptionSecret)
    const url = new URL(await service.beginConnect(testUser))
    const state = url.searchParams.get('state')!
    await expect(service.rejectConnect({ ...testUser, id: 'other-user' }, state)).rejects.toMatchObject({
      status: 403,
      code: 'SLACK_STATE_OWNER_MISMATCH',
    })
    await expect(service.rejectConnect(testUser, state)).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_SLACK_STATE',
    })
  })

  it('sends one real Slack API notification per sender and hour across job retries', async () => {
    const redis = fakeRedis()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, ts: '1710000000.000001' }))
    const prisma = {
      slackConnection: {
        findUnique: vi.fn(async () => connectedRow({ encryptedAccessToken: encryptForTest('xoxb-token') })),
      },
    }
    const service = new SlackService(
      prisma as never,
      redis as unknown as Redis,
      slackConfig,
      encryptionSecret,
      fetchImpl,
      async () => undefined,
    )

    expect(await service.notifyHourlyLimit(hourlyEvent)).toBe('sent')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const firstPayload = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    const retryPayload = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))
    expect(firstPayload).toMatchObject({
      channel: 'channel-1',
      text: expect.stringContaining('sender@example.com'),
    })
    expect(firstPayload.client_msg_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(retryPayload.client_msg_id).toBe(firstPayload.client_msg_id)
    expect(await service.notifyHourlyLimit(hourlyEvent)).toBe('duplicate')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries Slack server failures and does not mark failed notifications delivered', async () => {
    const redis = fakeRedis()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'internal_error' }, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'internal_error' }, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'internal_error' }, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: true, ts: '1710000000.000001' }))
    const prisma = {
      slackConnection: {
        findUnique: vi.fn(async () => connectedRow({ encryptedAccessToken: encryptForTest('xoxb-token') })),
      },
    }
    const service = new SlackService(
      prisma as never,
      redis as unknown as Redis,
      slackConfig,
      encryptionSecret,
      fetchImpl,
      async () => undefined,
    )
    await expect(service.notifyHourlyLimit(hourlyEvent)).rejects.toMatchObject({
      status: 502,
      code: 'SLACK_NOTIFICATION_FAILED',
    })
    expect([...redis.values.keys()].some((key) => key.includes(':sent:'))).toBe(false)
    expect(await service.notifyHourlyLimit(hourlyEvent)).toBe('sent')
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('serializes simultaneous notifications from competing workers', async () => {
    const redis = fakeRedis()
    let finishRequest!: (response: Response) => void
    const responsePending = new Promise<Response>((resolve) => { finishRequest = resolve })
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => responsePending)
    const service = new SlackService(
      {
        slackConnection: {
          findUnique: vi.fn(async () => connectedRow({ encryptedAccessToken: encryptForTest('xoxb-token') })),
        },
      } as never,
      redis as unknown as Redis,
      slackConfig,
      encryptionSecret,
      fetchImpl,
      async () => undefined,
    )

    const first = service.notifyHourlyLimit(hourlyEvent)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await service.notifyHourlyLimit(hourlyEvent)).toBe('busy')
    finishRequest(jsonResponse({ ok: true, ts: '1710000000.000001' }))
    expect(await first).toBe('sent')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('handles absent integration and marks revoked credentials for reconnection', async () => {
    const redis = fakeRedis()
    const empty = new SlackService({} as never, redis as unknown as Redis, null, encryptionSecret)
    expect(await empty.notifyHourlyLimit(hourlyEvent)).toBe('not-connected')

    const updateMany = vi.fn(async () => ({ count: 1 }))
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: false, error: 'token_revoked' }, 200))
    const prisma = {
      slackConnection: {
        findUnique: vi.fn(async () => connectedRow({ encryptedAccessToken: encryptForTest('xoxb-token') })),
        updateMany,
      },
    }
    const service = new SlackService(
      prisma as never,
      redis as unknown as Redis,
      slackConfig,
      encryptionSecret,
      fetchImpl,
      async () => undefined,
    )
    await expect(service.notifyHourlyLimit(hourlyEvent)).rejects.toMatchObject({ code: 'SLACK_TOKEN_REVOKED' })
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerId: testUser.id, teamId: 'team-1', revokedAt: null } }),
    )
    expect([...redis.values.keys()].some((key) => key.includes(':sent:'))).toBe(false)
  })

  it('sends the hourly-limit notification from the email worker before deferring delivery', async () => {
    const notifyHourlyLimit = vi.fn(async () => 'sent' as const)
    const email = {
      id: 'email-1',
      ownerId: testUser.id,
      senderId: 'sender-1',
      campaignId: 'campaign-1',
      status: 'scheduled',
      scheduledAt: new Date(Date.now() - 1000),
      sender: { id: 'sender-1', email: 'sender@example.com', displayName: null, hourlyLimitOverride: null },
      campaign: { id: 'campaign-1', hourlyLimit: null },
      recipientEmail: 'recipient@example.com',
      subject: 'Subject',
      bodyHtml: '<p>body</p>',
      bodyText: 'body',
    }
    const prisma = {
      email: {
        findUnique: vi.fn(async () => email),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    }
    const processor = createEmailProcessor({
      prisma: prisma as never,
      delivery: { send: vi.fn() } as never,
      hourly: {
        reserve: vi.fn(async () => ({
          granted: false as const,
          scope: 'sender' as const,
          window: 500,
          nextWindowAt: Date.now() + 60_000,
        })),
        refund: vi.fn(async () => true),
      },
      throttle: { tryAcquire: vi.fn() },
      slack: { notifyHourlyLimit },
      limits: { globalPerHour: 10, senderCapPerHour: 1 },
      staleProcessingMs: 300_000,
    })
    const moves: number[] = []
    const job = {
      id: 'email_email-1',
      data: { emailId: 'email-1' },
      attemptsMade: 0,
      opts: { attempts: 3 },
      moveToDelayed: async (time: number) => { moves.push(time) },
    } as unknown as ProcessableJob

    await expect(processor(job)).rejects.toBeInstanceOf(DelayedError)
    expect(notifyHourlyLimit).toHaveBeenCalledWith({
      ownerId: testUser.id,
      senderId: 'sender-1',
      senderEmail: 'sender@example.com',
      scope: 'sender',
      window: 500,
    })
    expect(moves).toHaveLength(1)
    expect(prisma.email.updateMany).toHaveBeenCalledTimes(2)
  })

  it('protects Slack status endpoints with authentication and scopes status to the user', async () => {
    const redis = fakeRedis()
    const findUnique = vi.fn(async () => ({ teamName: 'ReachInbox', channelName: '#ops', revokedAt: null }))
    const service = new SlackService(
      { slackConnection: { findUnique } } as never,
      redis as unknown as Redis,
      slackConfig,
      encryptionSecret,
    )
    const app = createApp({
      config: { FRONTEND_URL: 'http://localhost:3000', isProduction: false },
      prisma: {} as never,
      health: { prisma: {} as never, redis: { ping: async () => 'PONG' }, elasticsearchUrl: 'http://es.invalid' },
      authenticate: (req, _res, next) => {
        req.user = testUser
        next()
      },
      scheduling: { schedule: async () => { throw new Error('not used') } },
      auth: {} as AuthService,
      slack: service,
    })
    const response = await request(app).get('/api/slack/connection')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ connected: true, team: 'ReachInbox', channel: '#ops', revoked: false })
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerId: testUser.id } }),
    )

    const unauthorized = createApp({
      config: { FRONTEND_URL: 'http://localhost:3000', isProduction: false },
      prisma: {} as never,
      health: { prisma: {} as never, redis: { ping: async () => 'PONG' }, elasticsearchUrl: 'http://es.invalid' },
      authenticate: (_req, _res, next) => next(new AppError(401, 'UNAUTHENTICATED', 'Authentication required')),
      scheduling: { schedule: async () => { throw new Error('not used') } },
      auth: {} as AuthService,
      slack: service,
    })
    expect((await request(unauthorized).get('/api/slack/connection')).status).toBe(401)
  })

  it("disconnects only the authenticated owner's stored Slack integration", async () => {
    const redis = fakeRedis()
    const deleteMany = vi.fn(async () => ({ count: 1 }))
    const service = new SlackService(
      { slackConnection: { deleteMany } } as never,
      redis as unknown as Redis,
      slackConfig,
      encryptionSecret,
    )
    const app = createApp({
      config: { FRONTEND_URL: 'http://localhost:3000', isProduction: false },
      prisma: {} as never,
      health: { prisma: {} as never, redis: { ping: async () => 'PONG' }, elasticsearchUrl: 'http://es.invalid' },
      authenticate: (req, _res, next) => {
        req.user = testUser
        next()
      },
      scheduling: { schedule: async () => { throw new Error('not used') } },
      auth: {} as AuthService,
      slack: service,
    })
    const response = await request(app)
      .delete('/api/slack/connection')
      .set('Origin', 'http://localhost:3000')
    expect(response.status).toBe(204)
    expect(deleteMany).toHaveBeenCalledWith({ where: { ownerId: testUser.id } })
  })
})

function encryptForTest(token: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(encryptionSecret).digest(), iv)
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64')).join('.')
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { Redis } from 'ioredis'
import type { Config } from '../config/env'
import type { AuthUser } from '../middleware/auth'
import { AppError } from '../utils/errors'

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize'
const SLACK_ACCESS_URL = 'https://slack.com/api/oauth.v2.access'
const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage'
const STATE_TTL_SECONDS = 600
const NOTIFICATION_TTL_SECONDS = 35 * 24 * 60 * 60
const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

export type HourlyLimitEvent = {
  ownerId: string
  senderId: string
  senderEmail: string
  scope: 'global' | 'sender' | 'campaign'
  window: number
}

export type SlackNotificationResult = 'sent' | 'duplicate' | 'not-connected' | 'busy'

type SlackOAuthResponse = {
  ok?: boolean
  error?: string
  access_token?: string
  team?: { id?: string; name?: string }
  bot_user_id?: string
  incoming_webhook?: { channel_id?: string; channel?: string }
}

export class SlackService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly config: Config['slack'],
    private readonly encryptionSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async beginConnect(user: AuthUser): Promise<string> {
    const config = this.requireConfig()
    const state = randomBytes(32).toString('base64url')
    const result = await this.redis.set(
      `slack-oauth-state:${state}`,
      JSON.stringify({ ownerId: user.id }),
      'EX',
      STATE_TTL_SECONDS,
      'NX',
    )
    if (result !== 'OK') throw new AppError(503, 'SLACK_UNAVAILABLE', 'Could not start Slack connection')

    const url = new URL(SLACK_AUTHORIZE_URL)
    url.search = new URLSearchParams({
      client_id: config.clientId,
      scope: 'chat:write,incoming-webhook',
      redirect_uri: config.redirectUri,
      state,
    }).toString()
    return url.toString()
  }

  async completeConnect(user: AuthUser, code: string, state: string): Promise<void> {
    const config = this.requireConfig()
    if (!code || code.length > 4096 || !/^[A-Za-z0-9_-]{40,64}$/.test(state)) {
      throw new AppError(400, 'INVALID_SLACK_CALLBACK', 'Slack connection response is invalid')
    }
    await this.consumeState(user, state)

    const response = await this.request(SLACK_ACCESS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
      }),
    })
    if (!response.ok) throw new AppError(502, 'SLACK_UNAVAILABLE', 'Slack could not complete the connection')
    const body = await response.json() as SlackOAuthResponse
    if (
      body.ok !== true ||
      typeof body.access_token !== 'string' ||
      !body.access_token ||
      typeof body.team?.id !== 'string' ||
      typeof body.team.name !== 'string' ||
      typeof body.incoming_webhook?.channel_id !== 'string' ||
      typeof body.incoming_webhook.channel !== 'string'
    ) {
      throw new AppError(401, 'SLACK_AUTH_FAILED', 'Slack did not return a valid workspace and notification channel')
    }

    await this.prisma.slackConnection.upsert({
      where: { ownerId: user.id },
      create: {
        ownerId: user.id,
        teamId: body.team.id,
        teamName: body.team.name,
        encryptedAccessToken: encrypt(body.access_token, this.encryptionSecret),
        botUserId: typeof body.bot_user_id === 'string' ? body.bot_user_id : null,
        channelId: body.incoming_webhook.channel_id,
        channelName: body.incoming_webhook.channel,
        revokedAt: null,
      },
      update: {
        teamId: body.team.id,
        teamName: body.team.name,
        encryptedAccessToken: encrypt(body.access_token, this.encryptionSecret),
        botUserId: typeof body.bot_user_id === 'string' ? body.bot_user_id : null,
        channelId: body.incoming_webhook.channel_id,
        channelName: body.incoming_webhook.channel,
        revokedAt: null,
      },
    })
  }

  async rejectConnect(user: AuthUser, state: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(state)) {
      throw new AppError(400, 'INVALID_SLACK_CALLBACK', 'Slack connection response is invalid')
    }
    await this.consumeState(user, state)
  }

  async connectionStatus(ownerId: string): Promise<{
    connected: boolean
    team?: string
    channel?: string | null
    revoked?: boolean
  }> {
    const connection = await this.prisma.slackConnection.findUnique({
      where: { ownerId },
      select: { teamName: true, channelName: true, revokedAt: true },
    })
    if (!connection) return { connected: false }
    return {
      connected: connection.revokedAt === null,
      team: connection.teamName,
      channel: connection.channelName,
      revoked: connection.revokedAt !== null,
    }
  }

  async disconnect(ownerId: string): Promise<void> {
    await this.prisma.slackConnection.deleteMany({ where: { ownerId } })
  }

  async notifyHourlyLimit(event: HourlyLimitEvent): Promise<SlackNotificationResult> {
    if (!this.config) return 'not-connected'
    const connection = await this.prisma.slackConnection.findUnique({
      where: { ownerId: event.ownerId },
      select: { encryptedAccessToken: true, teamId: true, channelId: true, revokedAt: true },
    })
    if (!connection || connection.revokedAt || !connection.channelId) return 'not-connected'

    const eventId = createHash('sha256')
      .update(`${event.ownerId}:${event.senderId}:${event.window}`)
      .digest('hex')
    const sentKey = `slack:hourly-limit:sent:${eventId}`
    if (await this.redis.exists(sentKey)) return 'duplicate'
    const lockKey = `slack:hourly-limit:lock:${eventId}`
    const lockId = randomBytes(16).toString('hex')
    if ((await this.redis.set(lockKey, lockId, 'PX', 120_000, 'NX')) !== 'OK') return 'busy'

    try {
      if (await this.redis.exists(sentKey)) return 'duplicate'
      const token = decrypt(connection.encryptedAccessToken, this.encryptionSecret)
      const payload = {
        channel: connection.channelId,
        text: `Hourly email limit reached for sender ${event.senderEmail} (${event.scope} limit). Scheduled emails have been deferred to the next hour.`,
        client_msg_id: deterministicUuid(eventId),
      }
      await this.postMessage(token, { ownerId: event.ownerId, teamId: connection.teamId }, payload)
      await this.redis.set(sentKey, '1', 'EX', NOTIFICATION_TTL_SECONDS)
      return 'sent'
    } finally {
      await this.redis.eval(RELEASE_LOCK, 1, lockKey, lockId)
    }
  }

  private async postMessage(
    token: string,
    connection: { ownerId: string; teamId: string },
    payload: { channel: string; text: string; client_msg_id: string },
  ): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let response: Response
      let result: { ok?: boolean; error?: string; ts?: string }
      try {
        response = await this.request(SLACK_POST_MESSAGE_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify(payload),
        })
        result = await response.json() as { ok?: boolean; error?: string; ts?: string }
      } catch (err) {
        if (attempt === 3) throw err
        await this.sleep(200 * 2 ** (attempt - 1))
        continue
      }

      if (response.ok && result.ok === true && typeof result.ts === 'string') return
      const slackError = typeof result.error === 'string' ? result.error : 'unknown_error'
      if (['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed'].includes(slackError)) {
        await this.prisma.slackConnection.updateMany({
          where: { ownerId: connection.ownerId, teamId: connection.teamId, revokedAt: null },
          data: { revokedAt: new Date() },
        })
        throw new AppError(401, 'SLACK_TOKEN_REVOKED', 'Slack authorization has expired; reconnect Slack')
      }

      const retryable = response.status === 429 || response.status >= 500 || slackError === 'ratelimited'
      if (!retryable || attempt === 3) {
        throw new AppError(502, 'SLACK_NOTIFICATION_FAILED', `Slack notification failed (${slackError})`)
      }
      const retryAfter = Number(response.headers.get('retry-after'))
      const waitMs = response.status === 429 && Number.isFinite(retryAfter)
        ? Math.min(Math.max(retryAfter, 1), 30) * 1000
        : 200 * 2 ** (attempt - 1)
      await this.sleep(waitMs)
    }
  }

  private requireConfig(): NonNullable<Config['slack']> {
    if (!this.config) throw new AppError(503, 'SLACK_UNAVAILABLE', 'Slack integration is not configured')
    return this.config
  }

  private async request(input: string | URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(input, { ...init, signal: AbortSignal.timeout(10_000) })
    } catch {
      throw new AppError(502, 'SLACK_UNAVAILABLE', 'Slack is temporarily unavailable')
    }
  }

  private async consumeState(user: AuthUser, state: string): Promise<void> {
    const serialized = await this.redis.getdel(`slack-oauth-state:${state}`)
    if (!serialized) throw new AppError(400, 'INVALID_SLACK_STATE', 'Slack connection state is invalid or expired')
    let saved: { ownerId?: unknown }
    try {
      saved = JSON.parse(serialized) as { ownerId?: unknown }
    } catch {
      throw new AppError(400, 'INVALID_SLACK_STATE', 'Slack connection state is invalid or expired')
    }
    if (saved.ownerId !== user.id) {
      throw new AppError(403, 'SLACK_STATE_OWNER_MISMATCH', 'Slack connection belongs to a different user')
    }
  }
}

function encryptionKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

function encrypt(value: string, secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv, tag, ciphertext].map((part) => part.toString('base64')).join('.')
}

function decrypt(value: string, secret: string): string {
  const parts = value.split('.')
  if (parts.length !== 3) throw new AppError(500, 'SLACK_TOKEN_INVALID', 'Stored Slack authorization is invalid')
  try {
    const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part!, 'base64'))
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), iv!)
    decipher.setAuthTag(tag!)
    return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString('utf8')
  } catch {
    throw new AppError(500, 'SLACK_TOKEN_INVALID', 'Stored Slack authorization could not be decrypted')
  }
}

function deterministicUuid(hex: string): string {
  const bytes = Buffer.from(hex.slice(0, 32), 'hex')
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const value = bytes.toString('hex')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

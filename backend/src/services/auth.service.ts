import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { Redis } from 'ioredis'
import type { Config } from '../config/env'
import {
  requestCookie,
  SESSION_TTL_SECONDS,
  sessionCookieValue,
  sessionIdFromRequest,
  type AuthUser,
} from '../middleware/auth'
import { AppError } from '../utils/errors'

const STATE_TTL_SECONDS = 10 * 60
export const OAUTH_STATE_COOKIE = 'reachinbox.oauth_state'
const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_TOKEN_INFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo'

type OAuthState = { nonce: string; codeVerifier: string; browserBindingHash: string }
type GoogleClaims = {
  aud?: string
  iss?: string
  exp?: string
  nonce?: string
  sub?: string
  email?: string
  email_verified?: string
  name?: string
  picture?: string
}

export type AuthResult = { user: AuthUser; cookieValue: string }

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly google: Config['google'],
    private readonly sessionSecret: string,
    private readonly callbackUrl: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async beginLogin(cookieHeader?: string): Promise<{ redirectUrl: string; stateCookie: string }> {
    const google = this.requireGoogle()
    const state = randomBytes(32).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const codeVerifier = randomBytes(32).toString('base64url')
    const existingBinding = requestCookie(cookieHeader, OAUTH_STATE_COOKIE)
    const browserBinding = existingBinding && /^[a-f0-9]{64}$/.test(existingBinding)
      ? existingBinding
      : randomBytes(32).toString('hex')
    const codeChallenge = createCodeChallenge(codeVerifier)
    const saved = await this.redis.set(
      `oauth-state:${state}`,
      JSON.stringify({
        nonce,
        codeVerifier,
        browserBindingHash: hash(browserBinding),
      } satisfies OAuthState),
      'EX',
      STATE_TTL_SECONDS,
      'NX',
    )
    if (saved !== 'OK') throw new AppError(503, 'AUTH_UNAVAILABLE', 'Could not start Google sign-in')

    const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT)
    url.search = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: this.requireCallbackUrl(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString()
    return { redirectUrl: url.toString(), stateCookie: browserBinding }
  }

  async completeLogin(code: string, state: string, oldCookie: string | undefined): Promise<AuthResult> {
    const google = this.requireGoogle()
    if (!code || code.length > 4096 || !state || !/^[A-Za-z0-9_-]{40,64}$/.test(state)) {
      throw new AppError(400, 'INVALID_OAUTH_CALLBACK', 'Google sign-in response is invalid')
    }

    const stateValue = await this.redis.getdel(`oauth-state:${state}`)
    if (!stateValue) throw new AppError(400, 'INVALID_OAUTH_STATE', 'Google sign-in state is invalid or expired')
    let savedState: OAuthState
    try {
      savedState = JSON.parse(stateValue) as OAuthState
    } catch {
      throw new AppError(400, 'INVALID_OAUTH_STATE', 'Google sign-in state is invalid or expired')
    }
    if (!savedState.nonce || !savedState.codeVerifier || !/^[a-f0-9]{64}$/.test(savedState.browserBindingHash)) {
      throw new AppError(400, 'INVALID_OAUTH_STATE', 'Google sign-in state is invalid or expired')
    }
    const browserBinding = requestCookie(oldCookie, OAUTH_STATE_COOKIE)
    if (
      !browserBinding ||
      !/^[a-f0-9]{64}$/.test(browserBinding) ||
      !timingSafeEqual(Buffer.from(hash(browserBinding), 'hex'), Buffer.from(savedState.browserBindingHash, 'hex'))
    ) {
      throw new AppError(400, 'INVALID_OAUTH_STATE', 'Google sign-in state is invalid or expired')
    }

    const tokenResponse = await this.googleRequest(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: google.clientId,
        client_secret: google.clientSecret,
        redirect_uri: this.requireCallbackUrl(),
        grant_type: 'authorization_code',
        code_verifier: savedState.codeVerifier,
      }),
    })
    if (!tokenResponse.ok) throw new AppError(401, 'GOOGLE_AUTH_FAILED', 'Google could not verify this sign-in')
    const tokenPayload: unknown = await tokenResponse.json()
    const idToken = isRecord(tokenPayload) && typeof tokenPayload.id_token === 'string' ? tokenPayload.id_token : null
    if (!idToken || idToken.length > 16_384) throw new AppError(401, 'GOOGLE_AUTH_FAILED', 'Google did not return a valid identity token')

    const tokenInfoUrl = new URL(GOOGLE_TOKEN_INFO_ENDPOINT)
    tokenInfoUrl.searchParams.set('id_token', idToken)
    const identityResponse = await this.googleRequest(tokenInfoUrl, { method: 'GET' })
    if (!identityResponse.ok) throw new AppError(401, 'GOOGLE_AUTH_FAILED', 'Google identity verification failed')
    const rawClaims: unknown = await identityResponse.json()
    if (!isRecord(rawClaims)) throw new AppError(401, 'GOOGLE_AUTH_FAILED', 'Google identity verification failed')

    const claims = rawClaims as GoogleClaims
    const expiration = Number(claims.exp)
    if (
      claims.aud !== google.clientId ||
      !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss ?? '') ||
      !Number.isFinite(expiration) ||
      expiration <= Math.floor(Date.now() / 1000) ||
      claims.nonce !== savedState.nonce ||
      !claims.sub ||
      !claims.email ||
      claims.email_verified !== 'true'
    ) {
      throw new AppError(401, 'GOOGLE_AUTH_FAILED', 'Google identity claims are invalid')
    }

    let account
    try {
      account = await this.prisma.user.upsert({
        where: { googleSub: claims.sub },
        create: {
          googleSub: claims.sub,
          email: claims.email.toLowerCase(),
          name: claims.name?.trim() || claims.email.split('@')[0]!,
          avatarUrl: claims.picture ?? null,
        },
        update: {
          email: claims.email.toLowerCase(),
          name: claims.name?.trim() || claims.email.split('@')[0]!,
          avatarUrl: claims.picture ?? null,
        },
        select: { id: true, email: true, name: true },
      })
    } catch (err) {
      if (isRecord(err) && err.code === 'P2002') {
        throw new AppError(409, 'ACCOUNT_CONFLICT', 'This Google account could not be linked to an existing account')
      }
      throw err
    }

    const user: AuthUser = { id: account.id, email: account.email, name: account.name }
    const oldSessionId = sessionIdFromRequest(oldCookie, this.sessionSecret)
    const sessionId = randomBytes(32).toString('hex')
    await this.redis.set(`session:${sessionId}`, JSON.stringify({ user }), 'EX', SESSION_TTL_SECONDS)
    if (oldSessionId) await this.redis.del(`session:${oldSessionId}`)
    return { user, cookieValue: sessionCookieValue(sessionId, this.sessionSecret) }
  }

  async logout(cookieHeader: string | undefined): Promise<void> {
    const sessionId = sessionIdFromRequest(cookieHeader, this.sessionSecret)
    if (sessionId) await this.redis.del(`session:${sessionId}`)
  }

  private requireGoogle(): NonNullable<Config['google']> {
    if (!this.google) throw new AppError(503, 'AUTH_UNAVAILABLE', 'Google sign-in is not configured')
    return this.google
  }

  private requireCallbackUrl(): string {
    if (!this.callbackUrl) throw new AppError(503, 'AUTH_UNAVAILABLE', 'Google sign-in is not configured')
    return this.callbackUrl
  }

  private async googleRequest(input: string | URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(input, init)
    } catch {
      // In particular, do not propagate fetch errors that may contain the token-info URL and ID token.
      throw new AppError(502, 'GOOGLE_UNAVAILABLE', 'Google sign-in is temporarily unavailable')
    }
  }
}

function createCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

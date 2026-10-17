import type { PrismaClient } from '@prisma/client'
import type { Redis } from 'ioredis'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { sessionAuthentication, sessionCookieValue, SESSION_COOKIE } from '../src/middleware/auth'
import { AuthService, OAUTH_STATE_COOKIE } from '../src/services/auth.service'
import type { AuthService as AuthServiceType } from '../src/services/auth.service'

const secret = 'session-secret-for-auth-tests-32-chars'
const google = {
  clientId: 'google-client-id',
  clientSecret: 'google-client-secret',
  callbackUrl: 'http://localhost:4000/api/auth/google/callback',
}

function fakeRedis() {
  const values = new Map<string, string>()
  const redis = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    getdel: vi.fn(async (key: string) => {
      const value = values.get(key) ?? null
      values.delete(key)
      return value
    }),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value)
      return 'OK'
    }),
    del: vi.fn(async (...keys: string[]) => keys.reduce((n, key) => n + Number(values.delete(key)), 0)),
    values,
  }
  return redis
}

function appForAuth(redis: ReturnType<typeof fakeRedis>, auth: AuthServiceType) {
  const prisma = {
    $queryRaw: async () => [],
  } as never
  return createApp({
    config: { FRONTEND_URL: 'http://localhost:3000', isProduction: false },
    prisma,
    health: { prisma, redis: { ping: async () => 'PONG' }, elasticsearchUrl: 'http://es.invalid' },
    authenticate: sessionAuthentication(redis as unknown as Redis, secret),
    scheduling: { schedule: async () => { throw new Error('unused') } },
    auth,
  })
}

describe('Google authentication and sessions', () => {
  it('initiates Google login with a browser-bound state cookie', async () => {
    const redis = fakeRedis()
    const service = new AuthService({} as never, redis as unknown as Redis, google, secret, google.callbackUrl)
    const res = await request(appForAuth(redis, service)).get('/api/auth/google')
    expect(res.status).toBe(302)
    expect(res.headers.location).toContain('https://accounts.google.com/o/oauth2/v2/auth?')
    expect(res.headers['set-cookie']?.[0]).toContain(`${OAUTH_STATE_COOKIE}=`)
    expect(res.headers['set-cookie']?.[0]).toContain('HttpOnly')
    expect(redis.values.size).toBe(1)
  })

  it('validates state, exchanges and verifies Google identity, then creates a new session', async () => {
    const redis = fakeRedis()
    const userUpsert = vi.fn(async () => ({ id: 'user-1', email: 'user@example.com', name: 'User One' }))
    const prisma = { user: { upsert: userUpsert } } as never
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id_token: 'verified-id-token' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            aud: google.clientId,
            iss: 'https://accounts.google.com',
            exp: String(Math.floor(Date.now() / 1000) + 60),
            nonce: 'saved-nonce',
            sub: 'google-sub-1',
            email: 'user@example.com',
            email_verified: 'true',
            name: 'User One',
          }),
          { status: 200 },
        ),
      )
    const service = new AuthService(prisma, redis as unknown as Redis, google, secret, google.callbackUrl, fetchImpl)

    const login = await service.beginLogin()
    const url = new URL(login.redirectUrl)
    const state = url.searchParams.get('state')!
    const stored = JSON.parse(redis.values.get(`oauth-state:${state}`)!) as {
      nonce: string
      codeVerifier: string
      browserBindingHash: string
    }
    stored.nonce = 'saved-nonce'
    redis.values.set(`oauth-state:${state}`, JSON.stringify(stored))
    const priorSessionId = 'b'.repeat(64)
    redis.values.set(`session:${priorSessionId}`, JSON.stringify({ user: { id: 'old', email: 'old@example.com', name: 'Old' } }))
    const result = await service.completeLogin(
      'auth-code',
      state,
      `${SESSION_COOKIE}=${sessionCookieValue(priorSessionId, secret)}; ${OAUTH_STATE_COOKIE}=${login.stateCookie}`,
    )

    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(login.stateCookie).toMatch(/^[a-f0-9]{64}$/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(userUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { googleSub: 'google-sub-1' } }),
    )
    expect(result.user).toEqual({ id: 'user-1', email: 'user@example.com', name: 'User One' })
    expect(redis.values.has(`oauth-state:${state}`)).toBe(false)
    expect(redis.values.has(`session:${priorSessionId}`)).toBe(false)
    expect(redis.values.has(`session:${result.cookieValue.split('.')[0]}`)).toBe(true)
  })

  it('rejects missing or replayed OAuth state and missing Google configuration', async () => {
    const redis = fakeRedis()
    const prisma = {} as never
    const missingConfig = new AuthService(prisma, redis as unknown as Redis, null, secret, undefined)
    await expect(missingConfig.beginLogin()).rejects.toMatchObject({ status: 503, code: 'AUTH_UNAVAILABLE' })

    const service = new AuthService(prisma, redis as unknown as Redis, google, secret, google.callbackUrl)
    await expect(service.completeLogin('code', 'A'.repeat(43), undefined)).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_OAUTH_STATE',
    })
    const start = await service.beginLogin()
    const state = new URL(start.redirectUrl).searchParams.get('state')!
    await expect(
      service.completeLogin('code', state, `${OAUTH_STATE_COOKIE}=${'f'.repeat(64)}`),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_OAUTH_STATE' })
  })

  it('rejects an unverified Google identity before creating a user or session', async () => {
    const redis = fakeRedis()
    const userUpsert = vi.fn()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id_token: 'unverified-id-token' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            aud: google.clientId,
            iss: 'https://accounts.google.com',
            exp: String(Math.floor(Date.now() / 1000) + 60),
            nonce: 'expected-nonce',
            sub: 'google-sub-1',
            email: 'user@example.com',
            email_verified: 'false',
          }),
          { status: 200 },
        ),
      )
    const service = new AuthService(
      { user: { upsert: userUpsert } } as never,
      redis as unknown as Redis,
      google,
      secret,
      google.callbackUrl,
      fetchImpl,
    )
    const login = await service.beginLogin()
    const state = new URL(login.redirectUrl).searchParams.get('state')!
    const stored = JSON.parse(redis.values.get(`oauth-state:${state}`)!) as {
      nonce: string
      codeVerifier: string
      browserBindingHash: string
    }
    stored.nonce = 'expected-nonce'
    redis.values.set(`oauth-state:${state}`, JSON.stringify(stored))

    await expect(
      service.completeLogin('code', state, `${OAUTH_STATE_COOKIE}=${login.stateCookie}`),
    ).rejects.toMatchObject({ status: 401, code: 'GOOGLE_AUTH_FAILED' })
    expect(userUpsert).not.toHaveBeenCalled()
    expect([...redis.values.keys()].some((key) => key.startsWith('session:'))).toBe(false)
  })

  it('requires a valid server-side session and destroys it on logout', async () => {
    const redis = fakeRedis()
    const sessionId = 'a'.repeat(64)
    const cookie = sessionCookieValue(sessionId, secret)
    redis.values.set(`session:${sessionId}`, JSON.stringify({ user: { id: 'u1', email: 'a@example.com', name: 'A' } }))
    const service = new AuthService({} as never, redis as unknown as Redis, google, secret, google.callbackUrl)
    const app = appForAuth(redis, service)

    const unauthenticated = await request(app).get('/api/auth/me')
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.body.error.code).toBe('UNAUTHENTICATED')

    const current = await request(app).get('/api/auth/me').set('Cookie', `${SESSION_COOKIE}=${cookie}`)
    expect(current.status).toBe(200)
    expect(current.body.user).toEqual({ id: 'u1', email: 'a@example.com', name: 'A' })

    const logout = await request(app)
      .post('/api/auth/logout')
      .set('Origin', 'http://localhost:3000')
      .set('Cookie', `${SESSION_COOKIE}=${cookie}`)
    expect(logout.status).toBe(204)
    expect(redis.values.has(`session:${sessionId}`)).toBe(false)
    expect(logout.headers['set-cookie']?.[0]).toContain('HttpOnly')
  })

  it('rejects cross-origin state-changing requests', async () => {
    const redis = fakeRedis()
    const service = new AuthService({} as never, redis as unknown as Redis, google, secret, google.callbackUrl)
    const res = await request(appForAuth(redis, service))
      .post('/api/auth/logout')
      .set('Origin', 'https://attacker.example')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('CSRF_REJECTED')
  })
})

import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import type { AuthService } from '../src/services/auth.service'

function appWith(opts: { pg?: boolean; redis?: boolean; es?: boolean }) {
  const { pg = true, redis = true, es = true } = opts
  return createApp({
    config: { FRONTEND_URL: 'http://localhost:3000', isProduction: false },
    prisma: {} as never,
    health: {
      prisma: { $queryRaw: (async () => (pg ? [{ '?column?': 1 }] : Promise.reject(new Error('pg down')))) as never },
      redis: { ping: async () => (redis ? 'PONG' : Promise.reject(new Error('redis down'))) },
      elasticsearchUrl: 'http://es.invalid:9200',
      fetchImpl: (async () => (es ? new Response('{}', { status: 200 }) : Promise.reject(new Error('ECONNREFUSED')))) as never,
    },
    authenticate: (_req, _res, next) => next(),
    scheduling: { schedule: async () => Promise.reject(new Error('not used in health tests')) },
    auth: {} as AuthService,
  })
}

describe('GET /api/health', () => {
  it('returns ok when all components are up', async () => {
    const res = await request(appWith({})).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.components.postgres.status).toBe('up')
  })

  it('is degraded (still 200) when only Elasticsearch is down', async () => {
    const res = await request(appWith({ es: false })).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('degraded')
    expect(res.body.components.elasticsearch.status).toBe('down')
  })

  it('returns 503 when Redis is down', async () => {
    const res = await request(appWith({ redis: false })).get('/api/health')
    expect(res.status).toBe(503)
    expect(res.body.status).toBe('down')
  })

  it('returns 503 when PostgreSQL is down', async () => {
    const res = await request(appWith({ pg: false })).get('/api/health')
    expect(res.status).toBe(503)
  })
})

describe('app basics', () => {
  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(appWith({})).get('/api/nope')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('allows credentialed CORS only for the frontend origin', async () => {
    const ok = await request(appWith({})).get('/api/health').set('Origin', 'http://localhost:3000')
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000')
    expect(ok.headers['access-control-allow-credentials']).toBe('true')
    const evil = await request(appWith({})).get('/api/health').set('Origin', 'http://evil.example')
    expect(evil.headers['access-control-allow-origin']).not.toBe('http://evil.example')
  })

  it('returns INVALID_JSON for malformed bodies', async () => {
    const res = await request(appWith({})).post('/api/health').set('Content-Type', 'application/json').send('{bad')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_JSON')
  })
})

import type { PrismaClient } from '@prisma/client'
import type { Redis } from 'ioredis'

export type ComponentStatus = 'up' | 'down'
export interface ComponentHealth {
  status: ComponentStatus
  latencyMs?: number
  error?: string
}
export interface HealthReport {
  status: 'ok' | 'degraded' | 'down'
  time: string
  uptimeSec: number
  components: { postgres: ComponentHealth; redis: ComponentHealth; elasticsearch: ComponentHealth }
}

export interface HealthDeps {
  prisma: Pick<PrismaClient, '$queryRaw'>
  redis: Pick<Redis, 'ping'>
  elasticsearchUrl: string
  elasticsearchApiKey?: string
  fetchImpl?: typeof fetch
}

async function timed(fn: () => Promise<unknown>, timeoutMs = 2000): Promise<ComponentHealth> {
  const start = Date.now()
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
    return { status: 'up', latencyMs: Date.now() - start }
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Postgres and Redis are critical (scheduling cannot work without them) -> 'down'.
 * Elasticsearch only powers search; its outage is 'degraded', never 'down'.
 */
export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
  const f = deps.fetchImpl ?? fetch
  const [postgres, redis, elasticsearch] = await Promise.all([
    timed(() => deps.prisma.$queryRaw`SELECT 1`),
    timed(() => deps.redis.ping()),
    timed(async () => {
      const headers = new Headers()
      if (deps.elasticsearchApiKey) headers.set('authorization', `ApiKey ${deps.elasticsearchApiKey}`)
      const res = await f(`${deps.elasticsearchUrl.replace(/\/$/, '')}/_cluster/health`, {
        headers,
        signal: AbortSignal.timeout(2000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    }),
  ])
  const critical = postgres.status === 'up' && redis.status === 'up'
  return {
    status: !critical ? 'down' : elasticsearch.status === 'up' ? 'ok' : 'degraded',
    time: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    components: { postgres, redis, elasticsearch },
  }
}

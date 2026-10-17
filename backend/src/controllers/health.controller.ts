import type { RequestHandler } from 'express'
import { checkHealth, type HealthDeps } from '../services/health.service'

export const healthController =
  (deps: HealthDeps): RequestHandler =>
  async (_req, res, next) => {
    try {
      const report = await checkHealth(deps)
      // 503 only when a critical dependency is down; ES outage stays 200/degraded.
      res.status(report.status === 'down' ? 503 : 200).json(report)
    } catch (err) {
      next(err)
    }
  }

import type { RequestHandler } from 'express'
import { scheduleBodySchema } from '../schemas/schedule.schema'
import type { SchedulingService } from '../services/scheduling.service'
import { AppError } from '../utils/errors'

export type SchedulingPort = Pick<SchedulingService, 'schedule'>

export const scheduleController =
  (service: SchedulingPort): RequestHandler =>
  async (req, res, next) => {
    try {
      const user = req.user
      if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required')
      const body = scheduleBodySchema.parse(req.body) // ZodError -> 400 VALIDATION_ERROR via errorHandler
      const result = await service.schedule(user, body, req.header('idempotency-key') ?? undefined)
      res
        .status(result.replayed ? 200 : 201)
        .set('Idempotency-Replayed', String(result.replayed))
        .json(result)
    } catch (err) {
      next(err)
    }
  }

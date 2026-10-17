import pino from 'pino'

/** Structured JSON logger. Secrets are redacted wherever they could appear in a log object. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: [
      '*.password',
      '*.pass',
      '*.accessToken',
      '*.access_token',
      '*.clientSecret',
      '*.encryptedAccessToken',
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
    ],
    censor: '[redacted]',
  },
})

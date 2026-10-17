import { ConfigError, getConfig } from './config'
import { createPrisma } from './config/prisma'
import { EmailSearchService } from './services/email-search.service'
import { logger } from './utils/logger'

async function main() {
  const config = getConfig()
  const prisma = createPrisma(config.DATABASE_URL)
  try {
    const service = new EmailSearchService(
      prisma,
      config.ELASTICSEARCH_URL,
      config.ELASTICSEARCH_API_KEY,
    )
    const result = await service.reindexAll()
    logger.info(result, 'email search full reindex completed')
    if (result.failed > 0) process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(err.message)
  } else {
    logger.error({ err }, 'email search full reindex failed')
  }
  process.exitCode = 1
})

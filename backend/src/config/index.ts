import 'dotenv/config'
import { loadConfig, type Config } from './env'

let cached: Config | undefined

/** Validates the environment once, at first use. Throws ConfigError with every problem listed. */
export function getConfig(): Config {
  return (cached ??= loadConfig())
}

export { loadConfig, ConfigError, type Config } from './env'

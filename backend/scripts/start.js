#!/usr/bin/env node
/**
 * Production entrypoint (Railway / Docker).
 *  1. Validates environment and prints every problem in plain words (before Prisma's cryptic errors).
 *  2. Applies database migrations (prisma migrate deploy).
 *  3. Runs the API and the email worker in one container. If either exits, the container exits so the
 *     platform restarts it. Set RUN_WORKER=false to run the API only (e.g. a separate worker service),
 *     or START_MODE=worker to run only the worker.
 */
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')

const root = path.join(__dirname, '..')

function fail(lines) {
  console.error('\n==== ReachInbox cannot start ====')
  for (const l of lines) console.error(' - ' + l)
  console.error('Set these in Railway -> your service -> Variables, then redeploy.\n')
  process.exit(1)
}

// 1. Environment validation (reuses the app's own validator, so the rules never drift).
const missing = []
if (!process.env.DATABASE_URL) missing.push('DATABASE_URL is not set (Railway: add a Postgres service, then Variable = ${{Postgres.DATABASE_URL}})')
if (!process.env.REDIS_URL) missing.push('REDIS_URL is not set (Railway: add a Redis service, then Variable = ${{Redis.REDIS_URL}})')
if (missing.length) fail(missing)
try {
  require(path.join(root, 'dist/config')).loadConfig()
} catch (err) {
  fail(String(err.message || err).split('\n').filter((l) => l.trim() && !/^Invalid configuration/.test(l)).map((l) => l.replace(/^\s*-\s*/, '')))
}

// 2. Migrations.
const mode = process.env.START_MODE || 'all'
if (mode !== 'worker') {
  console.log('Applying database migrations...')
  const prisma = path.join(root, 'node_modules/.bin/prisma')
  const m = spawnSync(prisma, ['migrate', 'deploy'], { cwd: root, stdio: 'inherit' })
  if (m.status !== 0) fail(['prisma migrate deploy failed (see output above). Check DATABASE_URL and that the database is reachable.'])
}

// 3. Processes.
const procs = []
const run = (name, file) => {
  const p = spawn(process.execPath, [path.join(root, file)], { cwd: root, stdio: 'inherit', env: process.env })
  p.on('exit', (code, signal) => {
    console.error(`[start] ${name} exited (code=${code}, signal=${signal}); stopping container`)
    shutdown(code || 1)
  })
  procs.push(p)
}
let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const p of procs) if (!p.killed) p.kill('SIGTERM')
  setTimeout(() => process.exit(code), 12_000).unref()
  Promise.all(procs.map((p) => new Promise((r) => (p.exitCode !== null ? r() : p.once('exit', r))))).then(() => process.exit(code))
}
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))

if (mode !== 'worker') run('api', 'dist/server.js')
if (mode !== 'api' && process.env.RUN_WORKER !== 'false') run('worker', 'dist/worker.js')

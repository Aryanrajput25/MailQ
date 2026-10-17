import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPrisma } from '../src/config/prisma'

// Requires a migrated PostgreSQL. Skipped (and reported as skipped) when DATABASE_URL is unset.
const url = process.env.DATABASE_URL
const d = url ? describe : describe.skip

d('database schema (real PostgreSQL)', () => {
  let prisma: PrismaClient
  const tag = `t${Date.now()}`
  const userIds: string[] = []

  async function mkUser(n: string) {
    const u = await prisma.user.create({
      data: { googleSub: `${tag}-${n}`, name: n, email: `${tag}-${n}@example.com` },
    })
    userIds.push(u.id)
    const sender = await prisma.sender.create({ data: { ownerId: u.id, email: `from-${tag}-${n}@example.com` } })
    return { u, sender }
  }
  const emailData = (ownerId: string, senderId: string, key: string) => ({
    ownerId,
    senderId,
    recipientEmail: 'to@example.com',
    subject: 's',
    bodyHtml: '<p>b</p>',
    bodyText: 'b',
    scheduledAt: new Date(Date.now() + 60_000),
    idempotencyKey: key,
  })

  beforeAll(() => {
    prisma = createPrisma(url!)
  })
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.$disconnect()
  })

  it('defaults a new email to status "scheduled" with zero attempts', async () => {
    const { u, sender } = await mkUser('a')
    const e = await prisma.email.create({ data: emailData(u.id, sender.id, 'k1') })
    expect(e.status).toBe('scheduled')
    expect(e.attemptCount).toBe(0)
    expect(e.sentAt).toBeNull()
  })

  it('rejects a duplicate idempotency key for the same owner', async () => {
    const { u, sender } = await mkUser('b')
    await prisma.email.create({ data: emailData(u.id, sender.id, 'dup') })
    await expect(prisma.email.create({ data: emailData(u.id, sender.id, 'dup') })).rejects.toMatchObject({ code: 'P2002' })
  })

  it('allows the same idempotency key for different owners', async () => {
    const a = await mkUser('c')
    const b = await mkUser('d')
    await prisma.email.create({ data: emailData(a.u.id, a.sender.id, 'same') })
    await expect(prisma.email.create({ data: emailData(b.u.id, b.sender.id, 'same') })).resolves.toBeTruthy()
  })

  it('enforces unique deterministic job ids', async () => {
    const { u, sender } = await mkUser('e')
    await prisma.email.create({ data: { ...emailData(u.id, sender.id, 'j1'), jobId: `email-${tag}` } })
    await expect(
      prisma.email.create({ data: { ...emailData(u.id, sender.id, 'j2'), jobId: `email-${tag}` } }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })

  it('enforces foreign keys (sender must exist)', async () => {
    const { u } = await mkUser('f')
    await expect(prisma.email.create({ data: emailData(u.id, 'missing-sender', 'fk') })).rejects.toBeTruthy()
  })

  it('cascades deletion of a user to their senders and emails', async () => {
    const { u, sender } = await mkUser('g')
    // Emails reference senders with RESTRICT, so emails must go with the owner (cascade) first.
    await prisma.email.create({ data: emailData(u.id, sender.id, 'c1') })
    await prisma.user.delete({ where: { id: u.id } })
    expect(await prisma.email.count({ where: { ownerId: u.id } })).toBe(0)
    expect(await prisma.sender.count({ where: { ownerId: u.id } })).toBe(0)
  })

  it('allows only one Slack connection per user', async () => {
    const { u } = await mkUser('h')
    const data = { ownerId: u.id, teamId: 'T1', teamName: 'W', encryptedAccessToken: 'x' }
    await prisma.slackConnection.create({ data })
    await expect(prisma.slackConnection.create({ data })).rejects.toMatchObject({ code: 'P2002' })
  })
})

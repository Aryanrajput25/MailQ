import type { PrismaClient } from '@prisma/client'
import { jobIdForEmail, sortableId } from '../../src/utils/ids'

export interface Fixture {
  userId: string
  senderId: string
  campaignId: string
  senderEmail: string
}

let seq = 0
export const tag = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export async function createFixture(
  prisma: PrismaClient,
  opts: { senderLimit?: number | null; campaignLimit?: number | null; displayName?: string | null } = {},
): Promise<Fixture> {
  const t = tag()
  const user = await prisma.user.create({ data: { googleSub: `fx-${t}`, name: 'Fixture', email: `fx-${t}@example.com` } })
  const senderEmail = `oliver.${t}@domain.io`
  const sender = await prisma.sender.create({
    data: { ownerId: user.id, email: senderEmail, displayName: opts.displayName ?? 'Oliver Brown', hourlyLimitOverride: opts.senderLimit ?? null },
  })
  const campaign = await prisma.campaign.create({
    data: {
      ownerId: user.id,
      senderId: sender.id,
      subject: 'fixture',
      startAt: new Date(),
      idempotencyKey: `k-${t}`,
      recipientCount: 0,
      hourlyLimit: opts.campaignLimit ?? null,
    },
  })
  return { userId: user.id, senderId: sender.id, campaignId: campaign.id, senderEmail }
}

export async function createEmail(
  prisma: PrismaClient,
  fx: Fixture,
  over: Partial<{
    id: string
    status: 'scheduled' | 'processing' | 'sent' | 'failed' | 'cancelled'
    scheduledAt: Date
    processingStartedAt: Date | null
    smtpAttemptedAt: Date | null
    recipientEmail: string
    index: number
  }> = {},
) {
  const id = over.id ?? sortableId('eml', over.index ?? 0)
  const t = tag()
  return prisma.email.create({
    data: {
      id,
      ownerId: fx.userId,
      senderId: fx.senderId,
      campaignId: fx.campaignId,
      recipientEmail: over.recipientEmail ?? `to-${t}@example.com`,
      subject: 'Quarterly update',
      bodyHtml: '<p>Hello <b>there</b></p>',
      bodyText: 'Hello there',
      status: over.status ?? 'scheduled',
      scheduledAt: over.scheduledAt ?? new Date(Date.now() - 1000),
      processingStartedAt: over.processingStartedAt ?? null,
      smtpAttemptedAt: over.smtpAttemptedAt ?? null,
      jobId: jobIdForEmail(id),
      idempotencyKey: `ik-${t}`,
    },
  })
}

export async function cleanupFixtures(prisma: PrismaClient, userIds: string[]) {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
}

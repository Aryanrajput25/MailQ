import type { Prisma } from '@prisma/client'

export type Tx = Prisma.TransactionClient

const EMAIL_SELECT = {
  id: true,
  recipientEmail: true,
  scheduledAt: true,
  status: true,
  jobId: true,
} satisfies Prisma.EmailSelect

const CAMPAIGN_INCLUDE = { sender: { select: { id: true, email: true } } } satisfies Prisma.CampaignInclude

export type CampaignRecord = Prisma.CampaignGetPayload<{ include: typeof CAMPAIGN_INCLUDE }>
export type EmailSummary = Prisma.EmailGetPayload<{ select: typeof EMAIL_SELECT }>

// 15 columns/row; keep each INSERT far below PostgreSQL's 65,535 bind-parameter limit.
const INSERT_CHUNK = 1000

export const campaignRepository = {
  findByKey(tx: Tx, ownerId: string, idempotencyKey: string): Promise<CampaignRecord | null> {
    return tx.campaign.findUnique({
      where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } },
      include: CAMPAIGN_INCLUDE,
    })
  },

  /** Emails of a campaign in original recipient order (ids are time-sortable per batch). */
  emailsOf(tx: Tx, campaignId: string): Promise<EmailSummary[]> {
    return tx.email.findMany({ where: { campaignId }, orderBy: { id: 'asc' }, select: EMAIL_SELECT })
  },

  /** Senders are scoped per owner; the first use of an address registers it. */
  upsertSender(tx: Tx, ownerId: string, email: string) {
    return tx.sender.upsert({
      where: { ownerId_email: { ownerId, email } },
      create: { ownerId, email },
      update: {},
      select: { id: true, email: true },
    })
  },

  createCampaign(tx: Tx, data: Prisma.CampaignUncheckedCreateInput): Promise<CampaignRecord> {
    return tx.campaign.create({ data, include: CAMPAIGN_INCLUDE })
  },

  async createEmails(tx: Tx, rows: Prisma.EmailCreateManyInput[]): Promise<void> {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.email.createMany({ data: rows.slice(i, i + INSERT_CHUNK) })
    }
  },

  async createQueueOutbox(tx: Tx, rows: { emailId: string; jobId: string }[]): Promise<void> {
    await tx.queueOutbox.createMany({ data: rows })
  },
}

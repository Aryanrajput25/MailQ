import { randomBytes } from 'node:crypto'

/**
 * Time-sortable unique id: `eml_<ms-timestamp base36><index base36><random>`.
 * Ids created in one batch sort in input order, which keeps recipient ordering recoverable
 * from the database alone (later parts rely on this when rescheduling deferred emails).
 */
export function sortableId(prefix: string, index = 0, now = Date.now()): string {
  const ts = now.toString(36).padStart(9, '0')
  const seq = index.toString(36).padStart(5, '0')
  return `${prefix}_${ts}${seq}${randomBytes(5).toString('hex')}`
}

/** BullMQ forbids ':' in custom job ids, so the deterministic id uses '_'. */
export function jobIdForEmail(emailId: string): string {
  return `email_${emailId}`
}

import type { Database } from './db'

// Scheduled maintenance (design "Shared Infrastructure" step 2, H-04 step 3, L-15 prune and drain).
//
// Cost bound (AGENTS.md D1 quota): each run deletes at most MAINTENANCE_ROW_BUDGET rows in total,
// oauth_flows first, then sessions, then account_deletion_events with what is left. With the hourly trigger ("17 * * * *") and
// at most ~5 rows written per deleted row (table plus indexes), a day of pruning writes at most
// 24 * 200 * 5 = 24,000 rows, below the 30,000/day budget, however large the backlog is. The
// production backlog measured in task 11.8 was 46 rows, so the first run clears it.

export const MAINTENANCE_ROW_BUDGET = 200
const DAY_MS = 24 * 60 * 60 * 1000
/** Expired or revoked sessions are kept this long after they stopped working, then deleted. */
export const SESSION_RETENTION_GRACE_MS = 30 * DAY_MS

export interface MaintenanceResult {
  oauthFlowsDeleted: number
  sessionsDeleted: number
  accountDeletionEventsDeleted: number
}

export const runMaintenance = async (
  database: Database,
  now: number,
  {
    rowBudget = MAINTENANCE_ROW_BUDGET,
    avatarStorage = false,
  }: { rowBudget?: number; avatarStorage?: boolean } = {},
): Promise<MaintenanceResult> => {
  if (!Number.isInteger(rowBudget) || rowBudget < 1) throw new Error('invalid_maintenance_budget')
  // A flow is single-use and lives 10 minutes; once expired neither a callback nor a replay can
  // use it (the sealed cookie's own expiry is checked first), so it can go immediately.
  // Bounded through rowid so one statement never touches more than the budget (idx_oauth_flows_expiry).
  const flows = await database.prepare(`
    DELETE FROM oauth_flows WHERE rowid IN (
      SELECT rowid FROM oauth_flows WHERE expires_at < ? LIMIT ?
    )
  `).bind(now, rowBudget).run()
  const oauthFlowsDeleted = flows.meta.changes ?? 0
  const remaining = rowBudget - oauthFlowsDeleted
  let sessionsDeleted = 0
  if (remaining > 0) {
    const cutoff = now - SESSION_RETENTION_GRACE_MS
    const sessions = await database.prepare(`
      DELETE FROM sessions WHERE rowid IN (
        SELECT rowid FROM sessions
        WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)
        LIMIT ?
      )
    `).bind(cutoff, cutoff, remaining).run()
    sessionsDeleted = sessions.meta.changes ?? 0
  }
  // L-15 (D8 = stop emitting): the Worker has no avatar storage binding, so an avatar.delete row
  // can never be processed and only keeps a deleted account's ID. Without a binding every row is
  // drained; with one (avatarStorage) only rows that were already processed are. No migration:
  // the table stays so a rollback to v73 still finds it.
  let accountDeletionEventsDeleted = 0
  const left = remaining - sessionsDeleted
  if (left > 0) {
    const events = await database.prepare(`
      DELETE FROM account_deletion_events WHERE rowid IN (
        SELECT rowid FROM account_deletion_events
        WHERE ? = 0 OR processed_at IS NOT NULL
        LIMIT ?
      )
    `).bind(avatarStorage ? 1 : 0, left).run()
    accountDeletionEventsDeleted = events.meta.changes ?? 0
  }
  return { oauthFlowsDeleted, sessionsDeleted, accountDeletionEventsDeleted }
}

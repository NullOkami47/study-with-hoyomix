import type { Database } from "../db";
import { readRetentionPolicy, retentionCutoffSql, RETENTION_DAY_MS } from './retentionPolicy';
export const MESSAGE_CAP = 10000;
export const PARENT_BATCH = 10;
export const CHILD_BATCH = 100;
export async function retentionCount(db: Database) {
    const row = await db.prepare("SELECT message_count AS count FROM chat_retention_state WHERE room_id='global'").first<{
        count: number;
    }>();
    if (!row)
        throw new Error("chat_retention_state_missing");
    return row.count;
}
export async function nextRetention(db: Database, now: number) {
    const row = await db.prepare(`SELECT
      EXISTS(SELECT 1 FROM chat_retention_pending LIMIT 1) AS pending,
      (SELECT message_count FROM chat_retention_state WHERE room_id='global') AS count,
      ${retentionCutoffSql()} AS cutoff,
      coalesce((SELECT json_extract(setting_json,'$.retentionDays') FROM admin_settings WHERE setting_key='chat.retention'),30) AS days,
      (SELECT created_at FROM chat_messages WHERE room_id='global' ORDER BY created_at,id LIMIT 1) AS oldestCreated,
      (SELECT expires_at FROM chat_messages WHERE room_id='global' ORDER BY expires_at,id LIMIT 1) AS messageExpiry,
      (SELECT expires_at FROM chat_message_versions ORDER BY expires_at,id LIMIT 1) AS versionExpiry
    `).bind(now).first<{pending:number;count:number|null;cutoff:number;days:number;oldestCreated:number|null;messageExpiry:number|null;versionExpiry:number|null}>();
    if (!row || row.count === null) throw new Error('chat_retention_state_missing');
    if (row.pending || row.count > MESSAGE_CAP) return now;
    const policyExpiry = row.oldestCreated === null ? Infinity : row.oldestCreated <= row.cutoff ? now : row.oldestCreated+row.days*RETENTION_DAY_MS;
    return Math.min(policyExpiry,row.messageExpiry ?? Infinity,row.versionExpiry ?? Infinity);
}
/** Every batch is atomic. Remaining parent/child rows ARE durable progress:
 * the next invocation reselects the oldest unfinished parents after eviction.
 * No parent cascades until all its dependants have been explicitly drained. */
export async function prune(db: Database, now: number, reserve = false) {
    // An unreadable policy must not turn fail-closed visibility into deletion.
    await readRetentionPolicy(db);
    const count = await retentionCount(db);
    const overflow = Math.max(0, count - MESSAGE_CAP + (reserve ? 1 : 0));
    const pending = await db.prepare("SELECT message_id AS id FROM chat_retention_pending ORDER BY message_id LIMIT ?").bind(PARENT_BATCH).all<{
        id: string;
    }>();
    const candidates = pending.results.length ? pending : overflow
        ? await db.prepare("SELECT id FROM chat_messages WHERE room_id='global' ORDER BY created_at ASC,id ASC LIMIT ?").bind(Math.min(PARENT_BATCH, overflow)).all<{
            id: string;
        }>()
        : await db.prepare(`SELECT id FROM (
            SELECT id,created_at FROM (
              SELECT id,created_at FROM chat_messages WHERE room_id='global' AND expires_at<=?
              ORDER BY expires_at,id LIMIT ${PARENT_BATCH}
            )
            UNION
            SELECT id,created_at FROM (
              SELECT id,created_at FROM chat_messages WHERE room_id='global' AND created_at<=${retentionCutoffSql()}
              ORDER BY created_at,id LIMIT ${PARENT_BATCH}
            )
          ) ORDER BY created_at,id LIMIT ?`).bind(now, now, PARENT_BATCH).all<{
            id: string;
        }>();
    const ids = JSON.stringify(candidates.results.map(row => row.id));
    // Check before preparing mutation statements: the normal heartbeat path
    // neither constructs nor executes a write batch.
    if (!candidates.results.length) {
        const expired = await db.prepare("SELECT id FROM chat_message_versions WHERE expires_at<=? ORDER BY expires_at,id LIMIT 1").bind(now).first();
        if (!expired)
            return 0;
        await db.prepare(`DELETE FROM chat_message_versions WHERE id IN (SELECT id FROM chat_message_versions WHERE expires_at<=? ORDER BY expires_at,id LIMIT ${CHILD_BATCH})`).bind(now).run();
        return 0;
    }
    const statements = [db.prepare("INSERT OR IGNORE INTO chat_retention_pending(message_id) SELECT value FROM json_each(?)").bind(ids)];
    for (const [table, column] of [
        ["moderation_actions", "target_message_id"],
        ["chat_message_versions", "message_id"],
        ["chat_reports", "message_id"],
        // This table is WITHOUT ROWID; select its compound primary key.
    ])
        statements.push(db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${column} IN (SELECT value FROM json_each(?)) LIMIT ${CHILD_BATCH})`).bind(ids));
    statements.push(db.prepare(`DELETE FROM chat_request_receipts WHERE (user_id,request_id) IN (SELECT user_id,request_id FROM chat_request_receipts WHERE message_id IN (SELECT value FROM json_each(?)) LIMIT ${CHILD_BATCH})`).bind(ids));
    statements.push(db.prepare(`DELETE FROM chat_messages WHERE id IN (SELECT value FROM json_each(?))
    AND NOT EXISTS(SELECT 1 FROM moderation_actions WHERE target_message_id=chat_messages.id)
    AND NOT EXISTS(SELECT 1 FROM chat_message_versions WHERE message_id=chat_messages.id)
    AND NOT EXISTS(SELECT 1 FROM chat_reports WHERE message_id=chat_messages.id)
    AND NOT EXISTS(SELECT 1 FROM chat_request_receipts WHERE message_id=chat_messages.id)`).bind(ids));
    statements.push(db.prepare(`UPDATE chat_retention_state SET
    floor_created_at=CASE WHEN message_count-changes()<=${MESSAGE_CAP} THEN NULL ELSE floor_created_at END,
    floor_id=CASE WHEN message_count-changes()<=${MESSAGE_CAP} THEN NULL ELSE floor_id END,
    message_count=message_count-changes() WHERE room_id='global'`));
    statements.push(db.prepare(`DELETE FROM chat_message_versions WHERE id IN (SELECT id FROM chat_message_versions WHERE expires_at<=? ORDER BY expires_at,id LIMIT ${CHILD_BATCH})`).bind(now));
    await db.batch(statements);
    // Marking a pending eviction hides it immediately, even if child draining
    // needs several batches. Clients must replace their snapshot at that boundary.
    return candidates.results.length;
}

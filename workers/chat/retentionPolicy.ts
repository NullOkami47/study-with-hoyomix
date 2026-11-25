import type { Database } from '../db';
import { ChatError } from './protocol';

export const RETENTION_DAY_MS = 86400000;
export interface RetentionPolicy {
  retentionDays: number;
  revision: number;
  hiddenBefore: number;
}
const defaults: RetentionPolicy = { retentionDays: 30, revision: 0, hiddenBefore: 0 };
export function parseRetentionPolicy(value: string): RetentionPolicy {
  let policy: RetentionPolicy;
  try { policy = JSON.parse(value); } catch { throw new Error('chat_retention_policy_invalid'); }
  if (!policy || !Number.isSafeInteger(policy.retentionDays) || policy.retentionDays < 1 || policy.retentionDays > 30 ||
      !Number.isSafeInteger(policy.revision) || policy.revision < 0 ||
      !Number.isSafeInteger(policy.hiddenBefore) || policy.hiddenBefore < 0)
    throw new Error('chat_retention_policy_invalid');
  // Persist only the encoding produced by this module. This rejects duplicate
  // keys and numeric spellings that JSON.parse and SQLite interpret differently.
  if (value !== JSON.stringify({ retentionDays: policy.retentionDays, revision: policy.revision, hiddenBefore: policy.hiddenBefore }))
    throw new Error('chat_retention_policy_invalid');
  return policy;
}
export async function readRetentionPolicy(db: Database): Promise<RetentionPolicy> {
  const row = await db.prepare("SELECT setting_json AS value FROM admin_settings WHERE setting_key='chat.retention'").first<{value:string}>();
  return row ? parseRetentionPolicy(row.value) : {...defaults};
}
export async function updateRetentionPolicy(db: Database, retentionDays: number, expectedRevision: number, now: number, actorUserId: string): Promise<RetentionPolicy> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 30 ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(now) || now < 0) throw new ChatError('invalid_retention_policy');
  const row = await db.prepare("SELECT setting_json AS value FROM admin_settings WHERE setting_key='chat.retention'").first<{value:string}>();
  const previous = row ? parseRetentionPolicy(row.value) : defaults;
  if (previous.revision !== expectedRevision) throw new ChatError('retention_policy_conflict',409);
  const policy: RetentionPolicy = { retentionDays, revision: previous.revision+1,
    hiddenBefore: Math.max(previous.hiddenBefore, now-previous.retentionDays*RETENTION_DAY_MS, now-retentionDays*RETENTION_DAY_MS) };
  const value = JSON.stringify(policy);
  // D1 batch is one transaction. changes() refers to the immediately preceding
  // CAS write, so a competing save cannot append an audit for a rejected update.
  const save = row
    ? db.prepare("UPDATE admin_settings SET setting_json=?,updated_by=?,updated_at=? WHERE setting_key='chat.retention' AND setting_json=? RETURNING setting_json").bind(value,actorUserId,now,row.value)
    : db.prepare("INSERT OR IGNORE INTO admin_settings(setting_key,setting_json,updated_by,updated_at) VALUES ('chat.retention',?,?,?) RETURNING setting_json").bind(value,actorUserId,now);
  const [saved] = await db.batch([
    save,
    db.prepare("INSERT INTO admin_audit_log(id,actor_user_id,action,target_key,detail_json,created_at) SELECT ?,?,'chat.retention.update','chat.retention',?,? WHERE changes()=1")
      .bind(crypto.randomUUID(),actorUserId,JSON.stringify({previous,next:policy,timestamp:now}),now),
  ]);
  if (!saved.results.length) throw new ChatError('retention_policy_conflict',409);
  return policy;
}

/** Internal SQL expression; invalid persisted settings hide all messages. */
export function retentionCutoffSql(nowExpression = '?'): string {
  if (nowExpression !== '?' && !/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(nowExpression)) throw new Error('invalid_retention_now_expression');
  return `(SELECT CASE WHEN policy IS NULL THEN max(0,retention_clock.now-30*${RETENTION_DAY_MS})
    WHEN json_valid(policy) THEN CASE WHEN
      policy=json_object('retentionDays',json_extract(policy,'$.retentionDays'),'revision',json_extract(policy,'$.revision'),'hiddenBefore',json_extract(policy,'$.hiddenBefore'))
      AND json_type(policy,'$.retentionDays')='integer' AND json_extract(policy,'$.retentionDays') BETWEEN 1 AND 30
      AND json_type(policy,'$.revision')='integer' AND json_extract(policy,'$.revision') BETWEEN 0 AND 9007199254740991
      AND json_type(policy,'$.hiddenBefore')='integer' AND json_extract(policy,'$.hiddenBefore') BETWEEN 0 AND 9007199254740991
    THEN max(json_extract(policy,'$.hiddenBefore'),retention_clock.now-json_extract(policy,'$.retentionDays')*${RETENTION_DAY_MS})
    ELSE 9007199254740991 END ELSE 9007199254740991 END
    FROM (SELECT (SELECT setting_json FROM admin_settings WHERE setting_key='chat.retention') AS policy) CROSS JOIN (SELECT ${nowExpression} AS now) retention_clock)`;
}

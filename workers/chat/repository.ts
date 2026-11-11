import type { Database } from "../db";
import {
  ChatError,
  mask,
  type ChatMessage,
  type ChatUser,
  type FilterRule,
  type ChatRole,
} from "./protocol";

export interface MessageRow {
  id: string;
  userId: string | null;
  displayName: string;
  role: ChatRole | null;
  content: string;
  type: ChatMessage["type"];
  stickerId: string | null;
  trackId: string | null;
  location: string | null;
  createdAt: number;
  updatedAt: number | null;
  deletedAt: number | null;
  expiresAt: number;
}
const columns = `m.id,m.user_id AS userId,m.author_display_name AS displayName,u.role,m.content,
 m.message_type AS type,m.sticker_id AS stickerId,m.track_id AS trackId,m.coarse_location AS location,
 m.created_at AS createdAt,m.updated_at AS updatedAt,m.deleted_at AS deletedAt,m.expires_at AS expiresAt`;
export const iso = (value: number | null) =>
  value === null ? null : new Date(value).toISOString();
export async function sessionUser(
  db: Database,
  hash: string,
  now: number,
): Promise<ChatUser | null> {
  if (!hash) return null;
  return db
    .prepare(
      `SELECT u.id AS userId,u.role,u.display_name AS displayName FROM sessions s JOIN users u ON u.id=s.user_id
 WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.deleted_at IS NULL`,
    )
    .bind(hash, now)
    .first<ChatUser>();
}
export async function sessionUsers(
  db: Database,
  hashes: string[],
  now: number,
): Promise<Map<string, ChatUser>> {
  const unique = [...new Set(hashes.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await db
    .prepare(
      `SELECT s.token_hash AS sessionHash,u.id AS userId,u.role,u.display_name AS displayName
 FROM sessions s JOIN users u ON u.id=s.user_id
 WHERE s.token_hash IN(SELECT value FROM json_each(?)) AND s.revoked_at IS NULL AND s.expires_at>? AND u.deleted_at IS NULL`,
    )
    .bind(JSON.stringify(unique), now)
    .all<ChatUser & { sessionHash: string }>();
  return new Map(
    rows.results.map((row) => [
      row.sessionHash,
      { userId: row.userId, role: row.role, displayName: row.displayName },
    ]),
  );
}
export async function blockingViewers(
  db: Database,
  author: string,
  viewers: string[],
): Promise<Set<string>> {
  if (!viewers.length) return new Set();
  const rows = await db
    .prepare(
      "SELECT blocking_user_id AS id FROM user_blocks WHERE blocked_user_id=? AND blocking_user_id IN(SELECT value FROM json_each(?))",
    )
    .bind(author, JSON.stringify([...new Set(viewers)]))
    .all<{ id: string }>();
  return new Set(rows.results.map((row) => row.id));
}
export async function filters(db: Database): Promise<FilterRule[]> {
  const rows = await db
    .prepare(
      "SELECT id,kind,pattern,replacement,enabled FROM filter_rules ORDER BY created_at,id",
    )
    .all<FilterRule & { enabled: boolean | number }>();
  return rows.results.map((row) => ({ ...row, enabled: !!row.enabled }));
}
export async function blocked(
  db: Database,
  userId?: string,
): Promise<string[]> {
  if (!userId) return [];
  return (
    await db
      .prepare(
        "SELECT blocked_user_id AS id FROM user_blocks WHERE blocking_user_id=? ORDER BY blocked_user_id LIMIT 500",
      )
      .bind(userId)
      .all<{ id: string }>()
  ).results.map((row) => row.id);
}
export async function readMessage(
  db: Database,
  id: string,
  now: number,
): Promise<MessageRow | null> {
  return db
    .prepare(
      `SELECT ${columns} FROM chat_messages m LEFT JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.room_id='global' AND m.expires_at>?
 AND NOT EXISTS(SELECT 1 FROM chat_retention_pending WHERE message_id=m.id)
 AND ((SELECT floor_created_at FROM chat_retention_state WHERE room_id='global') IS NULL
 OR (m.created_at,m.id)>=(SELECT floor_created_at,floor_id FROM chat_retention_state WHERE room_id='global'))`,
    )
    .bind(id, now)
    .first<MessageRow>();
}
export function publicMessage(
  row: MessageRow,
  rules: FilterRule[],
): ChatMessage {
  return {
    id: row.id,
    userId: row.userId,
    displayName: row.displayName,
    role: row.role ?? "user",
    content: row.deletedAt === null ? mask(row.content, rules) : "",
    type: row.type,
    stickerId: row.deletedAt === null ? row.stickerId : null,
    trackId: row.deletedAt === null ? row.trackId : null,
    location: row.location,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt),
    deletedAt: iso(row.deletedAt),
  };
}
export async function history(
  db: Database,
  userId: string | undefined,
  now: number,
  before: string | null,
  requested: string | null,
) {
  const limit = requested === null ? 50 : Number(requested);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new ChatError("invalid_limit");
  let cursor: { time: number; id: string } | null = null;
  if (before) {
    try {
      if (before.length > 400) throw new Error();
      const parsed = JSON.parse(atob(before)) as unknown[];
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        !Number.isSafeInteger(parsed[0]) ||
        typeof parsed[1] !== "string" ||
        parsed[1].length > 100
      )
        throw new Error();
      cursor = { time: parsed[0] as number, id: parsed[1] };
    } catch {
      throw new ChatError("invalid_cursor");
    }
  }
  const rows = await db
    .prepare(
      `SELECT ${columns} FROM chat_messages m LEFT JOIN users u ON u.id=m.user_id
 WHERE m.room_id='global' AND m.expires_at>? AND m.deleted_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM chat_retention_pending WHERE message_id=m.id)
 AND ((SELECT floor_created_at FROM chat_retention_state WHERE room_id='global') IS NULL
 OR (m.created_at,m.id)>=(SELECT floor_created_at,floor_id FROM chat_retention_state WHERE room_id='global'))
 AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocking_user_id=? AND b.blocked_user_id=m.user_id)
 ${cursor ? "AND (m.created_at<? OR (m.created_at=? AND m.id<?))" : ""}
 ORDER BY m.created_at DESC,m.id DESC LIMIT ?`,
    )
    .bind(
      now,
      userId ?? "",
      ...(cursor ? [cursor.time, cursor.time, cursor.id] : []),
      limit + 1,
    )
    .all<MessageRow>();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  return {
    messages: page.reverse().map((row) => publicMessage(row, [])),
    nextCursor:
      rows.results.length > limit && last
        ? btoa(JSON.stringify([last.createdAt, last.id]))
        : null,
    rows: page,
  };
}
export async function publicHistory(
  db: Database,
  userId: string | undefined,
  now: number,
  before: string | null,
  limit: string | null,
) {
  const page = await history(db, userId, now, before, limit);
  const rules = await filters(db);
  return {
    messages: page.rows.map((row) => publicMessage(row, rules)),
    nextCursor: page.nextCursor,
  };
}
export async function interval(db: Database): Promise<number> {
  const row = await db
    .prepare(
      "SELECT setting_json AS value FROM admin_settings WHERE setting_key='chat.limits'",
    )
    .first<{ value: string }>();
  try {
    const value = JSON.parse(row?.value ?? "{}").intervalMs;
    return Number.isSafeInteger(value) && value >= 250 && value <= 60000
      ? value
      : 1500;
  } catch {
    return 1500;
  }
}
export async function requireNotBanned(
  db: Database,
  userId: string,
  now: number,
) {
  const ban = await db
    .prepare(
      "SELECT id FROM chat_bans WHERE user_id=? AND (expires_at IS NULL OR expires_at>?)",
    )
    .bind(userId, now)
    .first();
  if (ban) throw new ChatError("chat_banned", 403);
}

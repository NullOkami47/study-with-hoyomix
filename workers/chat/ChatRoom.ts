import type { Database, DatabaseStatement } from "../db";
import { readBoundedJsonRequest } from "../providers/boundedJson";
import type { ChatEnv } from "./routes";
import {
  ChatError,
  exactKeys,
  identifier,
  isModerator,
  json,
  object,
  STICKERS,
  text,
  validateFilter,
  type ChatIdentity,
  type ChatUser,
} from "./protocol";
import {
  blocked,
  blockingViewers,
  filters,
  interval,
  iso,
  prune,
  publicHistory,
  publicMessage,
  readMessage,
  requireNotBanned,
  sessionUser,
  sessionUsers,
} from "./repository";

interface Socket extends WebSocket {
  serializeAttachment(value: ChatIdentity): void;
  deserializeAttachment(): ChatIdentity;
}
interface State {
  acceptWebSocket(socket: WebSocket): void;
  getWebSockets(): Socket[];
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void;
  getWebSocketAutoResponseTimestamp(socket: WebSocket): Date | null;
  storage: {
    getAlarm(): Promise<number | null>;
    setAlarm(time: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
}
declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string);
}
declare const WebSocketPair: { new (): { 0: WebSocket; 1: Socket } };
const DAY = 86400000;
const STALE = 90000;

/** One global coordinator serialises HTTP mutations; sockets carry only reads.
 * All authoritative state lives in D1, so throttles, bans and idempotency survive
 * hibernation. Attachments contain a keyed session hash, never a browser token. */
export class ChatRoom {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private state: State,
    private env: ChatEnv,
  ) {
    state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }
  private get db(): Database {
    return this.env.DB;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => {});
    return result;
  }
  private async user(identity: ChatIdentity) {
    return sessionUser(this.db, identity.sessionHash, Date.now());
  }
  private async required(identity: ChatIdentity) {
    const user = await this.user(identity);
    if (!user) throw new ChatError("authentication_required", 401);
    return user;
  }
  private active(): Socket[] {
    const now = Date.now();
    return this.state
      .getWebSockets()
      .filter(
        (socket) =>
          socket.readyState === 1 &&
          now -
            Math.max(
              socket.deserializeAttachment().seenAt,
              this.state.getWebSocketAutoResponseTimestamp(socket)?.getTime() ??
                0,
            ) <
            STALE,
      );
  }
  private async audience() {
    const sockets = this.active();
    const users = await sessionUsers(
      this.db,
      sockets.map((socket) => socket.deserializeAttachment().sessionHash),
      Date.now(),
    );
    return { sockets, users };
  }
  private async presence() {
    const { sockets, users } = await this.audience();
    const people = new Set<string>();
    let ownerOnline = false,
      adminOnline = false;
    for (const socket of sockets) {
      const identity = socket.deserializeAttachment();
      const user = users.get(identity.sessionHash);
      people.add(user ? `user:${user.userId}` : `visitor:${identity.visitor}`);
      ownerOnline ||= user?.role === "owner";
      adminOnline ||= user?.role === "admin" || user?.role === "owner";
    }
    return { participants: people.size, ownerOnline, adminOnline };
  }
  private send(socket: Socket, value: unknown) {
    try {
      socket.send(JSON.stringify(value));
    } catch {
      try {
        socket.close(1011, "Connection failed");
      } catch {
        /* closed */
      }
    }
  }
  private async broadcast(
    event: Record<string, unknown>,
    author?: string | null,
  ) {
    const { sockets, users } = await this.audience();
    const hidden = author
      ? await blockingViewers(
          this.db,
          author,
          [...users.values()].map((user) => user.userId),
        )
      : new Set<string>();
    for (const socket of sockets) {
      // Resolve on every delivery: account deletion/revocation never leaves a
      // stale privileged identity attached to a hibernating connection.
      const user = users.get(socket.deserializeAttachment().sessionHash);
      if (user && hidden.has(user.userId)) continue;
      this.send(socket, event);
    }
  }
  private async schedule() {
    const now = Date.now();
    const expiry = await this.db
      .prepare(
        "SELECT MIN(expires_at) AS expiry FROM chat_messages WHERE room_id='global'",
      )
      .first<{ expiry: number | null }>();
    const next = Math.min(
      expiry?.expiry ?? Infinity,
      this.active().length ? now + 30000 : Infinity,
    );
    if (!Number.isFinite(next)) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const pending = await this.state.storage.getAlarm();
    if (pending === null || pending <= now || pending > next)
      await this.state.storage.setAlarm(Math.max(now + 1, next));
  }
  private async snapshot(socket: Socket) {
    const user = await this.user(socket.deserializeAttachment());
    socket.serializeAttachment({
      ...socket.deserializeAttachment(),
      viewerKey: user ? `${user.userId}:${user.role}` : "",
    });
    const page = await publicHistory(
      this.db,
      user?.userId,
      Date.now(),
      null,
      null,
    );
    this.send(socket, {
      type: "snapshot",
      ...page,
      viewer: user ? { userId: user.userId, role: user.role } : null,
      blockedUserIds: await blocked(this.db, user?.userId),
      ...(await this.presence()),
    });
  }
  async fetch(request: Request): Promise<Response> {
    return this.serial(async () => {
      try {
        const url = new URL(request.url);
        if (url.pathname === "/revalidate") {
          // Account deletion may have anonymised retained rows. Force every client
          // to replace its complete public snapshot and clear old author metadata.
          await this.broadcast({ type: "reset" });
          await this.broadcast({
            type: "presence",
            ...(await this.presence()),
          });
          return json({ ok: true });
        }
        const identity = JSON.parse(
          request.headers.get("x-chat-identity") ?? "null",
        ) as ChatIdentity | null;
        if (!identity) throw new ChatError("forbidden", 403);
        if (url.pathname === "/api/chat/socket") {
          const sockets = this.active();
          if (
            sockets.length >= 2000 ||
            sockets.filter((socket) => {
              const other = socket.deserializeAttachment();
              return identity.sessionHash
                ? other.sessionHash === identity.sessionHash
                : other.visitor === identity.visitor;
            }).length >= 5
          )
            throw new ChatError("connection_limit", 429);
          await prune(this.db, Date.now());
          const pair = new WebSocketPair();
          this.state.acceptWebSocket(pair[1]);
          pair[1].serializeAttachment(identity);
          await this.snapshot(pair[1]);
          await this.broadcast({
            type: "presence",
            ...(await this.presence()),
          });
          await this.schedule();
          return new Response(null, {
            status: 101,
            webSocket: pair[0],
          } as ResponseInit);
        }
        if (request.method === "GET" && url.pathname === "/api/chat") {
          await prune(this.db, Date.now());
          const user = await this.user(identity);
          return json(
            await publicHistory(
              this.db,
              user?.userId,
              Date.now(),
              url.searchParams.get("before"),
              url.searchParams.get("limit"),
            ),
          );
        }
        const user = await this.required(identity);
        if (url.pathname.startsWith("/api/chat/moderation"))
          return await this.moderation(request, url, user);
        if (
          url.pathname === "/api/chat/blocks" ||
          url.pathname.startsWith("/api/chat/blocks/")
        )
          return await this.blocks(request, url, user);
        await requireNotBanned(this.db, user.userId, Date.now());
        if (request.method === "POST" && url.pathname === "/api/chat/reports")
          return await this.report(request, user);
        if (request.method === "POST" && url.pathname === "/api/chat/messages")
          return await this.create(request, user, identity);
        const match = url.pathname.match(
          /^\/api\/chat\/messages\/([a-zA-Z0-9_-]{1,100})$/u,
        );
        if (match && ["PATCH", "DELETE"].includes(request.method))
          return await this.change(request, user, match[1]);
        return json({ error: "not_found" }, 404);
      } catch (error) {
        return error instanceof ChatError
          ? json({ error: error.code }, error.status)
          : json({ error: "chat_operation_failed" }, 500);
      }
    });
  }
  private async body(request: Request) {
    try {
      return object(await readBoundedJsonRequest(request, 8192));
    } catch (error) {
      if (error instanceof ChatError) throw error;
      throw new ChatError("invalid_request");
    }
  }
  private async create(
    request: Request,
    user: ChatUser,
    identity: ChatIdentity,
  ) {
    const body = await this.body(request),
      requestId = identifier(body.requestId),
      now = Date.now();
    exactKeys(body, [
      "requestId",
      "text",
      "type",
      "stickerId",
      "trackId",
      "showLocation",
    ]);
    const prior = await this.db
      .prepare(
        "SELECT message_id AS id FROM chat_request_receipts WHERE user_id=? AND request_id=?",
      )
      .bind(user.userId, requestId)
      .first<{ id: string }>();
    if (prior) {
      const existing = await readMessage(this.db, prior.id, now);
      if (existing) {
        await this.schedule();
        return json({
          message: publicMessage(existing, await filters(this.db)),
        });
      }
    }
    if (!["text", "sticker", "track"].includes(String(body.type)))
      throw new ChatError("invalid_type");
    const content =
      body.type === "text"
        ? text(body.text)
        : body.text === undefined || body.text === ""
          ? ""
          : text(body.text);
    const stickerId =
      body.type === "sticker" ? identifier(body.stickerId) : null;
    if (stickerId && !(STICKERS as readonly string[]).includes(stickerId))
      throw new ChatError("invalid_sticker");
    const trackId = body.type === "track" ? text(body.trackId, 256) : null;
    if (trackId) {
      const track = await this.db
        .prepare("SELECT track_id FROM catalogue_tracks WHERE track_id=?")
        .bind(trackId)
        .first();
      if (!track) throw new ChatError("unknown_track");
    }
    if (
      (body.type !== "sticker" && body.stickerId !== undefined) ||
      (body.type !== "track" && body.trackId !== undefined)
    )
      throw new ChatError("invalid_request");
    if (
      body.showLocation !== undefined &&
      typeof body.showLocation !== "boolean"
    )
      throw new ChatError("invalid_location");
    const last = await this.db
      .prepare(
        "SELECT last_sent_at AS time FROM chat_send_state WHERE user_id=?",
      )
      .bind(user.userId)
      .first<{ time: number }>();
    if (last && now - last.time < (await interval(this.db)))
      throw new ChatError("rate_limited", 429);
    const id = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO chat_messages(id,user_id,author_display_name,content,message_type,sticker_id,track_id,coarse_location,created_at,expires_at)VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          id,
          user.userId,
          user.displayName,
          content,
          body.type as string,
          stickerId,
          trackId,
          body.showLocation ? identity.country : null,
          now,
          now + 30 * DAY,
        ),
      this.db
        .prepare(
          "INSERT INTO chat_request_receipts(user_id,request_id,message_id)VALUES(?,?,?)",
        )
        .bind(user.userId, requestId, id),
      this.db
        .prepare(
          "INSERT INTO chat_send_state(user_id,last_sent_at)VALUES(?,?) ON CONFLICT(user_id)DO UPDATE SET last_sent_at=excluded.last_sent_at",
        )
        .bind(user.userId, now),
    ]);
    if (await prune(this.db, now)) await this.broadcast({ type: "reset" });
    const message = publicMessage(
      (await readMessage(this.db, id, now))!,
      await filters(this.db),
    );
    await this.broadcast({ type: "message", message }, user.userId);
    await this.schedule();
    return json({ message }, 201);
  }
  private async change(request: Request, user: ChatUser, id: string) {
    const now = Date.now(),
      row = await readMessage(this.db, id, now);
    if (!row || row.deletedAt !== null)
      throw new ChatError("message_not_found", 404);
    if (row.userId !== user.userId) throw new ChatError("forbidden", 403);
    if (now - row.createdAt > 300000)
      throw new ChatError("edit_window_expired", 403);
    if (request.method === "DELETE") {
      await this.db
        .prepare(
          "UPDATE chat_messages SET deleted_at=?,updated_at=? WHERE id=?",
        )
        .bind(now, now, id)
        .run();
      await this.broadcast({ type: "delete", id });
      return json({ ok: true });
    }
    if (row.type !== "text") throw new ChatError("text_edit_only");
    const body = await this.body(request),
      content = text(body.text);
    exactKeys(body, ["text"]);
    // Bound retained originals even if a client floods edits during the five-minute
    // window. The global coordinator serialises this check and atomic write.
    const versions = await this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM chat_message_versions WHERE message_id=?",
      )
      .bind(id)
      .first<{ count: number }>();
    if ((versions?.count ?? 0) >= 20) throw new ChatError("edit_limit", 429);
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO chat_message_versions(id,message_id,editor_user_id,original_content,created_at,expires_at)VALUES(?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          id,
          user.userId,
          row.content,
          now,
          row.expiresAt,
        ),
      this.db
        .prepare("UPDATE chat_messages SET content=?,updated_at=? WHERE id=?")
        .bind(content, now, id),
    ]);
    const message = publicMessage(
      (await readMessage(this.db, id, now))!,
      await filters(this.db),
    );
    await this.broadcast({ type: "message", message }, row.userId);
    return json({ message });
  }
  private async blocks(request: Request, url: URL, user: ChatUser) {
    if (request.method === "GET" && url.pathname === "/api/chat/blocks")
      return json({ blockedUserIds: await blocked(this.db, user.userId) });
    if (!["POST", "DELETE"].includes(request.method))
      throw new ChatError("method_not_allowed", 405);
    const target = identifier(
      request.method === "POST"
        ? (await this.body(request)).userId
        : decodeURIComponent(url.pathname.slice("/api/chat/blocks/".length)),
    );
    if (target === user.userId) throw new ChatError("cannot_block_self");
    if (request.method === "POST") {
      const exists = await this.db
        .prepare("SELECT id FROM users WHERE id=? AND deleted_at IS NULL")
        .bind(target)
        .first();
      if (!exists) throw new ChatError("user_not_found", 404);
      const total = await this.db
        .prepare(
          "SELECT COUNT(*) AS count,MAX(blocked_user_id=?) AS existing FROM user_blocks WHERE blocking_user_id=?",
        )
        .bind(target, user.userId)
        .first<{ count: number; existing: number | null }>();
      if ((total?.count ?? 0) >= 500 && !total?.existing)
        throw new ChatError("block_limit", 429);
      await this.db
        .prepare(
          "INSERT OR IGNORE INTO user_blocks(blocking_user_id,blocked_user_id,created_at)VALUES(?,?,?)",
        )
        .bind(user.userId, target, Date.now())
        .run();
    } else
      await this.db
        .prepare(
          "DELETE FROM user_blocks WHERE blocking_user_id=? AND blocked_user_id=?",
        )
        .bind(user.userId, target)
        .run();
    const audience = await this.audience();
    for (const socket of audience.sockets) {
      if (
        audience.users.get(socket.deserializeAttachment().sessionHash)
          ?.userId === user.userId
      )
        this.send(socket, { type: "reset" });
    }
    return json({ blockedUserIds: await blocked(this.db, user.userId) });
  }
  private async report(request: Request, user: ChatUser) {
    const body = await this.body(request),
      messageId = identifier(body.messageId),
      reason = text(body.reason);
    exactKeys(body, ["messageId", "reason"]);
    const row = await readMessage(this.db, messageId, Date.now());
    if (!row) throw new ChatError("message_not_found", 404);
    const prior = await this.db
      .prepare(
        "SELECT id FROM chat_reports WHERE reporter_user_id=? AND message_id=? AND status='pending'",
      )
      .bind(user.userId, messageId)
      .first<{ id: string }>();
    if (prior) return json({ id: prior.id }, 200);
    const pending = await this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM chat_reports WHERE reporter_user_id=? AND status='pending'",
      )
      .bind(user.userId)
      .first<{ count: number }>();
    if ((pending?.count ?? 0) >= 50) throw new ChatError("report_limit", 429);
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        "INSERT INTO chat_reports(id,reporter_user_id,message_id,reason,created_at)VALUES(?,?,?,?,?)",
      )
      .bind(id, user.userId, messageId, reason, Date.now())
      .run();
    return json({ id }, 201);
  }
  private audit(
    user: ChatUser,
    action: string,
    target: string,
    detail: Record<string, unknown>,
    now: number,
  ): DatabaseStatement {
    return this.db
      .prepare(
        "INSERT INTO admin_audit_log(id,actor_user_id,action,target_key,detail_json,created_at)VALUES(?,?,?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        user.userId,
        `chat.${action}`,
        target,
        JSON.stringify(detail),
        now,
      );
  }
  private moderationAudit(
    user: ChatUser,
    action: string,
    target: string | null,
    message: string | null,
    reason: string | null,
    expires: number | null,
    now: number,
  ) {
    return this.db
      .prepare(
        "INSERT INTO moderation_actions(id,actor_user_id,target_user_id,target_message_id,action,reason,expires_at,created_at)VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        user.userId,
        target,
        message,
        action,
        reason,
        expires,
        now,
      );
  }
  private async moderation(
    request: Request,
    url: URL,
    user: ChatUser,
  ): Promise<Response> {
    if (!isModerator(user.role)) throw new ChatError("forbidden", 403);
    const now = Date.now(),
      detail = url.pathname.match(
        /^\/api\/chat\/moderation\/messages\/([\w-]+)$/u,
      );
    if (request.method === "GET" && detail) {
      const message = await readMessage(this.db, detail[1], now);
      if (!message) throw new ChatError("message_not_found", 404);
      const versions = await this.db
        .prepare(
          "SELECT original_content AS content,created_at AS createdAt FROM chat_message_versions WHERE message_id=? AND expires_at>? ORDER BY created_at DESC,id DESC",
        )
        .bind(detail[1], now)
        .all<{ content: string; createdAt: number }>();
      return json({
        message: { ...publicMessage(message, []), content: message.content },
        versions: versions.results.map((row) => ({
          ...row,
          createdAt: iso(row.createdAt),
        })),
      });
    }
    if (url.pathname !== "/api/chat/moderation")
      throw new ChatError("not_found", 404);
    if (request.method === "GET") {
      const reports = await this.db
        .prepare(
          `SELECT r.id,r.message_id AS messageId,r.reason,r.created_at AS createdAt,m.content,m.user_id AS userId,m.author_display_name AS displayName FROM chat_reports r JOIN chat_messages m ON m.id=r.message_id WHERE r.status='pending' AND m.expires_at>? ORDER BY r.created_at LIMIT 100`,
        )
        .bind(now)
        .all<{ createdAt: number }>();
      const bans = await this.db
        .prepare(
          "SELECT b.id,b.user_id AS userId,u.display_name AS displayName,b.expires_at AS expiresAt FROM chat_bans b JOIN users u ON u.id=b.user_id WHERE b.expires_at IS NULL OR b.expires_at>? ORDER BY b.created_at DESC LIMIT 100",
        )
        .bind(now)
        .all<{ expiresAt: number | null }>();
      return json({
        viewer: { role: user.role },
        reports: reports.results.map((row) => ({
          ...row,
          createdAt: iso(row.createdAt),
        })),
        bans: bans.results.map((row) => ({
          ...row,
          expiresAt: iso(row.expiresAt),
        })),
        filters: await filters(this.db),
        intervalMs: await interval(this.db),
      });
    }
    if (request.method !== "POST")
      throw new ChatError("method_not_allowed", 405);
    const body = await this.body(request),
      action = String(body.action),
      statements: DatabaseStatement[] = [];
    exactKeys(body, [
      "action",
      "messageId",
      "userId",
      "reportId",
      "reason",
      "expiresAt",
      "filter",
      "filterId",
      "intervalMs",
    ]);
    const manager = ["admin", "owner"].includes(user.role);
    if (["filter", "remove_filter", "settings"].includes(action) && !manager)
      throw new ChatError("forbidden", 403);
    if (action === "delete") {
      const id = identifier(body.messageId),
        message = await readMessage(this.db, id, now);
      if (!message) throw new ChatError("message_not_found", 404);
      statements.push(
        this.db
          .prepare(
            "UPDATE chat_messages SET deleted_at=?,updated_at=? WHERE id=?",
          )
          .bind(now, now, id),
        this.moderationAudit(
          user,
          "delete_message",
          message.userId,
          id,
          text(body.reason ?? "Moderated"),
          null,
          now,
        ),
      );
    } else if (action === "ban" || action === "unban") {
      const id = identifier(body.userId),
        target = await this.db
          .prepare("SELECT role FROM users WHERE id=? AND deleted_at IS NULL")
          .bind(id)
          .first<{ role: string }>();
      if (!target) throw new ChatError("user_not_found", 404);
      const rank: Record<string, number> = {
        user: 0,
        moderator: 1,
        admin: 2,
        owner: 3,
      };
      if (rank[target.role] >= rank[user.role])
        throw new ChatError("forbidden", 403);
      if (action === "ban") {
        const expires =
          body.expiresAt == null
            ? null
            : typeof body.expiresAt === "string"
              ? Date.parse(body.expiresAt)
              : NaN;
        if (
          expires !== null &&
          (!Number.isSafeInteger(expires) ||
            expires <= now ||
            expires > now + 365 * DAY)
        )
          throw new ChatError("invalid_expiry");
        const reason = text(body.reason ?? "Moderated");
        statements.push(
          this.db
            .prepare(
              "INSERT INTO chat_bans(id,user_id,actor_user_id,reason,expires_at,created_at)VALUES(?,?,?,?,?,?) ON CONFLICT(user_id)DO UPDATE SET actor_user_id=excluded.actor_user_id,reason=excluded.reason,expires_at=excluded.expires_at,created_at=excluded.created_at",
            )
            .bind(crypto.randomUUID(), id, user.userId, reason, expires, now),
          this.moderationAudit(
            user,
            expires === null ? "permanent_ban" : "temporary_ban",
            id,
            null,
            reason,
            expires,
            now,
          ),
        );
      } else
        statements.push(
          this.db.prepare("DELETE FROM chat_bans WHERE user_id=?").bind(id),
        );
    } else if (action === "resolve") {
      const id = identifier(body.reportId),
        report = await this.db
          .prepare(
            "SELECT message_id AS messageId FROM chat_reports WHERE id=? AND status='pending'",
          )
          .bind(id)
          .first<{ messageId: string }>();
      if (!report) throw new ChatError("report_not_found", 404);
      const reason = text(body.reason ?? "Reviewed");
      statements.push(
        this.db
          .prepare(
            "UPDATE chat_reports SET status='resolved',resolved_by=?,resolution_note=?,resolved_at=? WHERE id=?",
          )
          .bind(user.userId, reason, now, id),
        this.moderationAudit(
          user,
          "resolve_report",
          null,
          report.messageId,
          reason,
          null,
          now,
        ),
      );
    } else if (action === "filter") {
      const rule = validateFilter(body.filter);
      const count = await this.db
        .prepare("SELECT COUNT(*) AS count FROM filter_rules")
        .first<{ count: number }>();
      if (
        (count?.count ?? 0) >= 100 &&
        !(await this.db
          .prepare("SELECT id FROM filter_rules WHERE id=?")
          .bind(rule.id)
          .first())
      )
        throw new ChatError("filter_limit");
      statements.push(
        this.db
          .prepare(
            "INSERT INTO filter_rules(id,kind,pattern,replacement,enabled,created_by,updated_by,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id)DO UPDATE SET kind=excluded.kind,pattern=excluded.pattern,replacement=excluded.replacement,enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
          )
          .bind(
            rule.id,
            rule.kind,
            rule.pattern,
            "***",
            rule.enabled ? 1 : 0,
            user.userId,
            user.userId,
            now,
            now,
          ),
      );
    } else if (action === "remove_filter")
      statements.push(
        this.db
          .prepare("DELETE FROM filter_rules WHERE id=?")
          .bind(identifier(body.filterId ?? object(body.filter).id)),
      );
    else if (action === "settings") {
      if (
        !Number.isSafeInteger(body.intervalMs) ||
        Number(body.intervalMs) < 250 ||
        Number(body.intervalMs) > 60000
      )
        throw new ChatError("invalid_interval");
      statements.push(
        this.db
          .prepare(
            "INSERT INTO admin_settings(setting_key,setting_json,updated_by,updated_at)VALUES('chat.limits',?,?,?) ON CONFLICT(setting_key)DO UPDATE SET setting_json=excluded.setting_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
          )
          .bind(
            JSON.stringify({ intervalMs: body.intervalMs }),
            user.userId,
            now,
          ),
      );
    } else throw new ChatError("invalid_action");
    statements.push(
      this.audit(
        user,
        action,
        String(body.messageId ?? body.userId ?? body.reportId ?? "settings"),
        {},
        now,
      ),
    );
    await this.db.batch(statements);
    if (action === "delete")
      await this.broadcast({ type: "delete", id: body.messageId });
    else await this.broadcast({ type: "reset" });
    return json({ ok: true });
  }
  async webSocketMessage(
    socket: Socket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (
      typeof message !== "string" ||
      new TextEncoder().encode(message).byteLength > 1024
    ) {
      socket.close(1009, "Message too large");
      return;
    }
    if (message !== "refresh") {
      socket.close(1008, "Unsupported event");
      return;
    }
    const identity = socket.deserializeAttachment(),
      now = Date.now();
    if (identity.refreshedAt && now - identity.refreshedAt < 2000) {
      socket.close(1008, "Refresh rate exceeded");
      return;
    }
    socket.serializeAttachment({ ...identity, refreshedAt: now });
    try {
      await this.serial(() => this.snapshot(socket));
    } catch {
      socket.close(1011, "Chat unavailable");
    }
    // Auth and writes are intentionally HTTP-only. A socket cannot forge role,
    // location or bypass coordinator validation with a client event.
  }
  async webSocketClose(socket: Socket): Promise<void> {
    await this.serial(async () => {
      try {
        socket.close();
      } catch {
        /* closed */
      }
      await this.broadcast({ type: "presence", ...(await this.presence()) });
      await this.schedule();
    });
  }
  async webSocketError(socket: Socket): Promise<void> {
    await this.serial(async () => {
      try {
        socket.close(1011, "Connection failed");
      } catch {
        /* closed */
      }
      await this.schedule();
    });
  }
  async alarm(): Promise<void> {
    await this.serial(async () => {
      if (await prune(this.db, Date.now()))
        await this.broadcast({ type: "reset" });
      const audience = await this.audience(),
        active = new Set(audience.sockets);
      for (const socket of this.state.getWebSockets()) {
        if (!active.has(socket)) {
          try {
            socket.close(1001, "Heartbeat expired");
          } catch {
            /* closed */
          }
        }
      }
      for (const socket of audience.sockets) {
        const identity = socket.deserializeAttachment(),
          user = audience.users.get(identity.sessionHash),
          key = user ? `${user.userId}:${user.role}` : "";
        if (identity.viewerKey !== key) {
          socket.serializeAttachment({ ...identity, viewerKey: key });
          this.send(socket, { type: "reset" });
        }
      }
      await this.broadcast({ type: "presence", ...(await this.presence()) });
      await this.schedule();
    });
  }
}

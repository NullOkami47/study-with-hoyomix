import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare } from "./miniflare-compat";
import { ChatRoom } from "../chat/ChatRoom";
import { issueSession } from "../auth/session";
import { deleteAccount } from "../library/repository";
import type { ChatIdentity } from "../chat/protocol";

const now = Date.parse("2026-10-17T00:00:00Z"),
  secret = "chat-lifecycle-secret-at-least-thirty-two-characters";
let runtime: Miniflare,
  db: Awaited<ReturnType<Miniflare["getD1Database"]>>,
  identity: ChatIdentity;
beforeAll(async () => {
  const worker = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import {ChatRoom} from './workers/chat/ChatRoom';
      export default {async fetch(request, env) {
        const now=Number(request.headers.get('x-fixture-now'));Date.now=()=>now;
        let alarm=null;const values=new Map();
        const state={setWebSocketAutoResponse(){},getWebSockets(){return []},
          storage:{async get(key){return values.get(key)},async put(key,value){values.set(key,value)},
            async getAlarm(){return alarm},async setAlarm(value){alarm=value},async deleteAlarm(){alarm=null}}};
        let batches=0;
        const limit=Number(new URL(request.url).searchParams.get('limit')||'1000');
        do {await new ChatRoom(state,env).alarm();batches++} while(alarm!==null && batches<limit);
        return Response.json({batches,alarm});
      }};` }, bundle: true, write: false, format: "esm", platform: "browser",
  });
  runtime = new Miniflare({
    modules: true,
    script: worker.outputFiles[0].text,
    compatibilityDate: "2025-12-01",
    d1Databases: { DB: "chat-lifecycle" },
  });
  db = await runtime.getD1Database("DB");
  for (const file of (await readdir("migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort())
    await db.batch(
      (await readFile(`migrations/${file}`, "utf8"))
        .split(";")
        .map((sql) => sql.trim())
        .filter(Boolean)
        .map((sql) => db.prepare(sql)),
    );
});
afterAll(async () => {
  await runtime?.dispose();
});
beforeEach(async () => {
  await db.prepare("DELETE FROM users").run();
  await db.prepare("DELETE FROM chat_messages").run();
  await db.prepare("DELETE FROM moderation_actions").run();
  await db.prepare("UPDATE chat_retention_state SET message_count=0,floor_created_at=NULL,floor_id=NULL").run();
  await db
    .prepare(
      "INSERT INTO users(id,display_name,role,created_at,updated_at)VALUES('alice','Alice','user',?,?)",
    )
    .bind(now, now)
    .run();
  const session = await issueSession(db as never, "alice", secret, now, crypto);
  identity = {
    sessionHash: session.record.tokenHash,
    visitor: "visitor",
    country: "TW",
    seenAt: now,
    viewerKey: "alice:user",
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubGlobal(
    "WebSocketRequestResponsePair",
    class {
      constructor(
        public request: string,
        public response: string,
      ) {}
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture(socketIdentity?: ChatIdentity) {
  let attachment = socketIdentity,
    alarm: number | null = null;
  const durable = new Map<string, unknown>();
  const events: Record<string, unknown>[] = [],
    closed: number[] = [];
  const socket = {
    readyState: 1,
    deserializeAttachment: () => attachment!,
    serializeAttachment: (value: ChatIdentity) => {
      attachment = value;
    },
    send: (value: string) => events.push(JSON.parse(value)),
    close(code = 1000) {
      this.readyState = 2;
      closed.push(code);
    },
  };
  const state = {
    acceptWebSocket: () => {},
    getWebSockets: () => (socketIdentity ? [socket] : []),
    setWebSocketAutoResponse: () => {},
    getWebSocketAutoResponseTimestamp: () => new Date(Date.now()),
    storage: {
      get: async <T>(key: string) => durable.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { durable.set(key, value); },
      getAlarm: async () => alarm,
      setAlarm: async (value: number) => {
        alarm = value;
      },
      deleteAlarm: async () => {
        alarm = null;
      },
    },
  };
  const env = {
    DB: db,
    PUBLIC_ORIGIN: "https://study.example",
    SESSION_HMAC_SECRET: secret,
  };
  const room = () => new ChatRoom(state as never, env as never);
  return { room, state, socket, events, closed, alarm: () => alarm };
}
const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`https://chat.internal${path}`, {
    method,
    headers: {
      "x-chat-identity": JSON.stringify(identity),
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
async function insert(id: string, created = now, expires = now + 1000) {
  await db
    .prepare(
      "INSERT INTO chat_messages(id,user_id,author_display_name,content,coarse_location,created_at,expires_at)VALUES(?,'alice','Alice','private original','TW',?,?)",
    )
    .bind(id, created, expires)
    .run();
  await db.prepare("UPDATE chat_retention_state SET message_count=message_count+1").run();
}

describe("D1 retention, reconstruction and failures", () => {
  it("prunes 10,005 messages to 10,000 and removes the remainder on an idle expiry alarm after reconstruction", async () => {
    await db
      .prepare(
        `WITH RECURSIVE seq(x)AS(SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<10005)
  INSERT INTO chat_messages(id,user_id,author_display_name,content,created_at,expires_at)
  SELECT printf('bulk-%05d',x),'alice','Alice','bulk',?-x,? FROM seq`,
      )
      .bind(now, now + 1000)
      .run();
    await db.prepare("UPDATE chat_retention_state SET message_count=(SELECT COUNT(*) FROM chat_messages)").run();
    const f = fixture();
    await f.room().alarm();
    expect(
      await db.prepare("SELECT COUNT(*) AS count FROM chat_messages").first(),
    ).toMatchObject({ count: 10000 });
    expect(
      await db
        .prepare("SELECT id FROM chat_messages WHERE id='bulk-10005'")
        .first(),
    ).toBeNull();
    expect(f.alarm()).toBe(now + 1000);
    vi.setSystemTime(now + 1001);
    // Run the complete 10k backlog against native D1 bindings in workerd.
    // Node's cross-process D1 proxy per statement would test RPC overhead here.
    // Cap each dispatch well below the per-request D1 volume that resets the
    // dispatch socket on newer pinned miniflare/workerd builds; every batch
    // still runs inside workerd and the loop keeps its overall 1000-batch cap.
    let batches = 0;
    let drained: { batches: number; alarm: number | null } | undefined;
    for (let chunk = 0; chunk < 20 && (!drained || drained.alarm !== null); chunk++) {
      const drain = await runtime.dispatchFetch("https://local.invalid/drain?limit=100", {headers:{"x-fixture-now":String(now+1001)}});
      drained = (await drain.json()) as { batches: number; alarm: number | null };
      batches += drained.batches;
    }
    expect(drained).toMatchObject({alarm:null});
    expect(batches).toBeGreaterThan(0);
    await f.room().alarm();
    expect(
      await db.prepare("SELECT COUNT(*) AS count FROM chat_messages").first(),
    ).toMatchObject({ count: 0 });
    expect(f.alarm()).toBeNull();
  });
  it("expires original versions, reports and associated moderation text with the parent message", async () => {
    await insert("expires");
    await db
      .prepare(
        "INSERT INTO chat_message_versions(id,message_id,editor_user_id,original_content,created_at,expires_at)VALUES('version','expires','alice','old private',?,?)",
      )
      .bind(now, now + 1000)
      .run();
    await db
      .prepare(
        "INSERT INTO chat_reports(id,reporter_user_id,message_id,reason,created_at)VALUES('report','alice','expires','private reason',?)",
      )
      .bind(now)
      .run();
    await db
      .prepare(
        "INSERT INTO moderation_actions(id,target_message_id,action,reason,created_at)VALUES('action','expires','delete_message','private context',?)",
      )
      .bind(now)
      .run();
    vi.setSystemTime(now + 1001);
    await fixture().room().alarm();
    for (const table of [
      "chat_messages",
      "chat_message_versions",
      "chat_reports",
      "moderation_actions",
    ])
      expect(
        await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first(),
      ).toMatchObject({ count: 0 });
  });
  it("retains send throttles and request receipts across object reconstruction", async () => {
    const f = fixture(),
      body = { requestId: "durable-send", type: "text", text: "durable" };
    const first = await f
      .room()
      .fetch(request("/api/chat/messages", "POST", body));
    expect(first.status).toBe(201);
    const id = ((await first.json()) as any).message.id;
    const second = await f
      .room()
      .fetch(request("/api/chat/messages", "POST", body));
    expect(((await second.json()) as any).message.id).toBe(id);
    expect(
      (
        await f.room().fetch(
          request("/api/chat/messages", "POST", {
            ...body,
            requestId: "after-wake",
          }),
        )
      ).status,
    ).toBe(429);
  });
  it("does not broadcast a successful message when D1 rejects the atomic insert", async () => {
    await db
      .prepare(
        "CREATE TRIGGER reject_chat BEFORE INSERT ON chat_messages BEGIN SELECT RAISE(ABORT,'test unavailable'); END",
      )
      .run();
    const f = fixture(identity);
    try {
      expect(
        (
          await f.room().fetch(
            request("/api/chat/messages", "POST", {
              requestId: "failure",
              type: "text",
              text: "never sent",
            }),
          )
        ).status,
      ).toBe(500);
      expect(f.events).toEqual([]);
      expect(
        await db
          .prepare("SELECT COUNT(*) AS count FROM chat_request_receipts")
          .first(),
      ).toMatchObject({ count: 0 });
    } finally {
      await db.prepare("DROP TRIGGER reject_chat").run();
    }
  });
  it("revalidates revoked or changed sessions after reconstruction without retaining a moderator badge", async () => {
    const f = fixture(identity);
    await db
      .prepare("UPDATE users SET role='moderator' WHERE id='alice'")
      .run();
    await f.room().alarm();
    expect(f.events).toContainEqual({ type: "reset" });
    f.events.length = 0;
    await db.prepare("UPDATE sessions SET revoked_at=?").bind(now).run();
    await f.room().alarm();
    expect(f.events).toContainEqual({ type: "reset" });
    expect(
      (
        await f.room().fetch(
          request("/api/chat/messages", "POST", {
            requestId: "revoked",
            type: "text",
            text: "no",
          }),
        )
      ).status,
    ).toBe(401);
  });
  it("expires temporary bans and keeps permanent bans through reconstruction", async () => {
    await db
      .prepare(
        "INSERT INTO chat_bans(id,user_id,reason,expires_at,created_at)VALUES('ban','alice','reason',?,?)",
      )
      .bind(now + 1000, now)
      .run();
    const f = fixture(),
      body = {
        requestId: "ban-test",
        type: "text",
        text: "allowed after expiry",
      };
    expect(
      (await f.room().fetch(request("/api/chat/messages", "POST", body)))
        .status,
    ).toBe(403);
    vi.setSystemTime(now + 1001);
    expect(
      (await f.room().fetch(request("/api/chat/messages", "POST", body)))
        .status,
    ).toBe(201);
    await db.prepare("UPDATE chat_bans SET expires_at=NULL").run();
    vi.setSystemTime(now + 100000);
    expect(
      (
        await f.room().fetch(
          request("/api/chat/messages", "POST", {
            ...body,
            requestId: "permanent",
          }),
        )
      ).status,
    ).toBe(403);
  });
  it("uses both timestamp and ID when paginating equal-time messages", async () => {
    for (const id of ["same-a", "same-b", "same-c"]) await insert(id);
    const f = fixture(),
      first = (await (
        await f.room().fetch(request("/api/chat?limit=2"))
      ).json()) as any;
    expect(first.messages.map((item: any) => item.id)).toEqual([
      "same-b",
      "same-c",
    ]);
    const second = (await (
      await f
        .room()
        .fetch(
          request(
            `/api/chat?limit=2&before=${encodeURIComponent(first.nextCursor)}`,
          ),
        )
    ).json()) as any;
    expect(second.messages.map((item: any) => item.id)).toEqual(["same-a"]);
    expect(second.nextCursor).toBeNull();
  });
  it("clears deleted-account versions, coarse location and associated private moderation text atomically", async () => {
    await insert("anonymised");
    await db
      .prepare(
        "INSERT INTO chat_message_versions(id,message_id,editor_user_id,original_content,created_at,expires_at)VALUES('old','anonymised','alice','private old',?,?)",
      )
      .bind(now, now + 1000)
      .run();
    await db
      .prepare(
        "INSERT INTO moderation_actions(id,target_user_id,target_message_id,action,reason,created_at)VALUES('audit','alice','anonymised','delete_message','private identity',?)",
      )
      .bind(now)
      .run();
    await deleteAccount(db as never, "alice", now, "deletion");
    expect(
      await db
        .prepare(
          "SELECT user_id,author_display_name,coarse_location FROM chat_messages WHERE id='anonymised'",
        )
        .first(),
    ).toEqual({
      user_id: null,
      author_display_name: "Deleted user",
      coarse_location: null,
    });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM chat_message_versions")
        .first(),
    ).toMatchObject({ count: 0 });
    expect(
      await db
        .prepare("SELECT reason FROM moderation_actions WHERE id='audit'")
        .first(),
    ).toEqual({ reason: null });
  });
  it("caps account block lists while preserving idempotence and replacement after unblock", async () => {
    await db
      .prepare(
        `WITH RECURSIVE seq(x)AS(SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<501)
      INSERT INTO users(id,display_name,role,created_at,updated_at) SELECT 'blocked-'||x,'Blocked','user',?,? FROM seq`,
      )
      .bind(now, now)
      .run();
    await db
      .prepare(
        "INSERT INTO user_blocks(blocking_user_id,blocked_user_id,created_at) SELECT 'alice',id,? FROM users WHERE id LIKE 'blocked-%' AND id<>'blocked-501'",
      )
      .bind(now)
      .run();
    const f = fixture();
    expect(
      (
        await f
          .room()
          .fetch(request("/api/chat/blocks", "POST", { userId: "blocked-501" }))
      ).status,
    ).toBe(429);
    expect(
      (
        await f
          .room()
          .fetch(request("/api/chat/blocks", "POST", { userId: "blocked-1" }))
      ).status,
    ).toBe(200);
    expect(
      (await f.room().fetch(request("/api/chat/blocks/blocked-1", "DELETE")))
        .status,
    ).toBe(200);
    expect(
      (
        await f
          .room()
          .fetch(request("/api/chat/blocks", "POST", { userId: "blocked-501" }))
      ).status,
    ).toBe(200);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM user_blocks WHERE blocking_user_id='alice'",
        )
        .first(),
    ).toEqual({ count: 500 });
  });
  it("bounds each message to twenty original versions across reconstruction while allowing an immediate edit", async () => {
    await insert("bounded-edits", now, now + 30 * 86400000);
    const f = fixture();
    for (let index = 0; index < 20; index++) {
      const response = await f.room().fetch(
        request("/api/chat/messages/bounded-edits", "PATCH", {
          text: `revision ${index}`,
        }),
      );
      expect(response.status).toBe(200);
    }
    const rejected = await f.room().fetch(
      request("/api/chat/messages/bounded-edits", "PATCH", {
        text: "unbounded",
      }),
    );
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toEqual({ error: "edit_limit" });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM chat_message_versions WHERE message_id='bounded-edits'",
        )
        .first(),
    ).toEqual({ count: 20 });
    expect(
      await db
        .prepare("SELECT content FROM chat_messages WHERE id='bounded-edits'")
        .first(),
    ).toEqual({ content: "revision 19" });
    expect(
      (
        await f
          .room()
          .fetch(request("/api/chat/messages/bounded-edits", "DELETE"))
      ).status,
    ).toBe(200);
  });
  it("revalidates a 2,000-socket audience with bounded D1 queries per alarm", async () => {
    let queries = 0;
    const counted = {
      prepare(sql: string) {
        queries++;
        if (queries > 49) throw new Error("D1 query budget exceeded");
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
      exec: db.exec.bind(db),
    };
    const sockets = Array.from({ length: 2000 }, (_, index) => {
      let attachment = {
        ...identity,
        sessionHash: `hmac-sha256:v1:${index.toString(16).padStart(64, "0")}`,
        viewerKey: "",
      };
      return {
        readyState: 1,
        deserializeAttachment: () => attachment,
        serializeAttachment: (next: typeof attachment) => {
          attachment = next;
        },
        send: () => {},
        close: () => {},
      };
    });
    const state = {
      getWebSockets: () => sockets,
      acceptWebSocket: () => {},
      setWebSocketAutoResponse: () => {},
      getWebSocketAutoResponseTimestamp: () => new Date(now),
      storage: {
        get: async () => undefined,
        put: async () => {},
        getAlarm: async () => null,
        setAlarm: async () => {},
        deleteAlarm: async () => {},
      },
    };
    await new ChatRoom(state as never, { DB: counted } as never).alarm();
    expect(queries).toBeLessThan(15);
  });
});

describe("bounded HTTP admission outside the mutation queue", () => {
  function streaming(room: ChatRoom, path = "/api/chat/messages") {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; value.enqueue(new TextEncoder().encode('{')); },
      cancel() { cancelled = true; },
    });
    const response = room.fetch(new Request(`https://chat.internal${path}`, {
      method: "POST", headers: { "x-chat-identity": JSON.stringify(identity), "content-type": "application/json" },
      body, duplex: "half",
    } as RequestInit));
    return { response, controller, cancelled: () => cancelled };
  }
  it("unfinished authenticated bodies cannot block history, sends, WS delivery/refresh or alarms", async () => {
    const f = fixture(identity), room = f.room();
    const slow = streaming(room);
    const independent = (async () => {
      expect((await room.fetch(request('/api/chat'))).status).toBe(200);
      expect((await room.fetch(request('/api/chat/messages', 'POST', {requestId:'parallel', type:'text', text:'available'}))).status).toBe(201);
      expect(f.events.some(e => e.type === 'message')).toBe(true);
      await room.webSocketMessage(f.socket as never, 'refresh');
      expect(f.events.some(e => e.type === 'snapshot')).toBe(true);
      await room.alarm();
      return true;
    })();
    const { setTimeout } = await import('node:timers/promises');
    try {
      expect(await Promise.race([independent, setTimeout(3000, false)])).toBe(true);
    } finally {
      slow.controller.close();
      expect((await slow.response).status).toBe(400);
      await independent;
    }
    expect(await db.prepare('SELECT COUNT(*) AS count FROM chat_messages').first()).toMatchObject({count:1});
  });
  it("rejects a Session revoked while its body was pending at the protected boundary", async () => {
    const room = fixture().room(), slow = streaming(room);
    await db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').bind(now, identity.sessionHash).run();
    slow.controller.enqueue(new TextEncoder().encode('"requestId":"revoked","type":"text","text":"denied"}'));
    slow.controller.close();
    expect((await slow.response).status).toBe(401);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM chat_messages').first()).toMatchObject({count:0});
  });
  it("rechecks moderation role after a pending body completes", async () => {
    await db.prepare("UPDATE users SET role='admin' WHERE id='alice'").run();
    const room = fixture().room(), slow = streaming(room, '/api/chat/moderation');
    await db.prepare("UPDATE users SET role='user' WHERE id='alice'").run();
    slow.controller.enqueue(new TextEncoder().encode('"action":"settings","intervalMs":250}'));
    slow.controller.close();
    expect((await slow.response).status).toBe(403);
  });
});


describe('bounded retention work',()=>{
 it('history performs no cleanup writes and never exposes expired messages',async()=>{
  await insert('old',now-2000,now-1000);
  const response=await fixture().room().fetch(request('/api/chat'));
  expect((await response.json() as any).messages).toEqual([]);
  expect(await db.prepare("SELECT id FROM chat_messages WHERE id='old'").first()).not.toBeNull();
 });
 it('one alarm bounds physical parent deletions during an expiry backlog',async()=>{
  await db.prepare(`WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<1000)
   INSERT INTO chat_messages(id,author_display_name,content,created_at,expires_at) SELECT printf('expiry-%04d',x),'test','expired',0,1 FROM seq`).run();
  await db.prepare("UPDATE chat_retention_state SET message_count=(SELECT COUNT(*) FROM chat_messages)").run();
  await fixture().room().alarm();
  const row=await db.prepare('SELECT COUNT(*) AS count FROM chat_messages').first<{count:number}>();
  expect(row!.count).toBeGreaterThanOrEqual(990);expect(row!.count).toBeLessThan(1000);
 });
});


describe('ChatRoom stream limits and atomic admission',()=>{
 function stream(room: ChatRoom) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled=false;
  const response=room.fetch(new Request('https://chat.internal/api/chat/messages',{
   method:'POST',headers:{'x-chat-identity':JSON.stringify(identity),'content-type':'application/json'},
   body:new ReadableStream<Uint8Array>({start(c){controller=c;c.enqueue(new TextEncoder().encode('{'))},cancel(){cancelled=true}}),duplex:'half',
  } as RequestInit));
  return {response,controller,cancelled:()=>cancelled};
 }
 it('limits outstanding streams per Session, cancels rejection and releases slots after deadline',async()=>{
  const room=fixture().room(), a=stream(room),b=stream(room),c=stream(room);
  expect((await c.response).status).toBe(429);expect(c.cancelled()).toBe(true);
  const {setTimeout}=await import('node:timers/promises');await setTimeout(30);
  await setTimeout(5100);
  expect((await a.response).status).toBe(400);expect((await b.response).status).toBe(400);
  expect(a.cancelled()).toBe(true);expect(b.cancelled()).toBe(true);
  expect((await room.fetch(request('/api/chat/messages','POST',{requestId:'after-timeout',type:'text',text:'available'}))).status).toBe(201);
 });
 it('concurrent identical requestIds create exactly one ordered message and receipt',async()=>{
  const room=fixture(identity).room(),body={requestId:'simultaneous',type:'text',text:'once'};
  const responses=await Promise.all([room.fetch(request('/api/chat/messages','POST',body)),room.fetch(request('/api/chat/messages','POST',body))]);
  expect(responses.map(r=>r.status).sort()).toEqual([200,201]);
  const messages=await Promise.all(responses.map(r=>r.json() as Promise<any>));expect(messages[0].message.id).toBe(messages[1].message.id);
  expect(await db.prepare('SELECT COUNT(*) AS count FROM chat_messages').first()).toMatchObject({count:1});
  expect(await db.prepare('SELECT COUNT(*) AS count FROM chat_request_receipts').first()).toMatchObject({count:1});
  expect(await db.prepare('SELECT message_count AS count FROM chat_retention_state').first()).toMatchObject({count:1});
 });
 it('keeps partially drained parents hidden and resumes bounded child cleanup after reconstruction',async()=>{
  await insert('large',0,1);
  await db.prepare(`WITH RECURSIVE seq(x)AS(SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<250)
   INSERT INTO chat_reports(id,message_id,reason,status,created_at) SELECT printf('report-%03d',x),'large','expired reason','resolved',0 FROM seq`).run();
  const f=fixture();await f.room().alarm();
  expect(await db.prepare("SELECT id FROM chat_messages WHERE id='large'").first()).not.toBeNull();
  expect(await db.prepare('SELECT COUNT(*) AS count FROM chat_reports').first()).toMatchObject({count:150});
  expect((await (await f.room().fetch(request('/api/chat'))).json() as any).messages).toEqual([]);
  await f.room().alarm();await f.room().alarm();
  expect(await db.prepare('SELECT COUNT(*) AS count FROM chat_messages').first()).toMatchObject({count:0});
  expect(await db.prepare('PRAGMA foreign_key_check').all()).toMatchObject({results:[]});
 });
 it('atomically rolls back failed cleanup and persists a no-retry stop after reconstruction',async()=>{
  await insert('failure',0,1);
  await db.prepare("CREATE TRIGGER reject_retention BEFORE DELETE ON chat_messages BEGIN SELECT RAISE(ABORT,'cleanup unavailable'); END").run();
  const f=fixture();try {
   await expect(f.room().alarm()).rejects.toThrow();
   expect(await f.state.storage.get('retention-paused')).toBe(true);
   expect(await db.prepare('SELECT COUNT(*) AS count FROM chat_retention_pending').first()).toMatchObject({count:0});
   await db.prepare('DROP TRIGGER reject_retention').run();
   await f.room().alarm();expect(await db.prepare('SELECT COUNT(*) AS count FROM chat_messages').first()).toMatchObject({count:1});
  } finally {await db.prepare('DROP TRIGGER IF EXISTS reject_retention').run()}
 });
});


it('bounds global body admission across independent valid Sessions',async()=>{
 const room=fixture().room();const identities:ChatIdentity[]=[];
 for(let i=0;i<33;i++){
  const session=await issueSession(db as never,'alice',secret,now,crypto);
  identities.push({...identity,sessionHash:session.record.tokenHash});
 }
 const controllers:ReadableStreamDefaultController<Uint8Array>[]=[];
 const responses=identities.map(id=>room.fetch(new Request('https://chat.internal/api/chat/messages',{
  method:'POST',headers:{'x-chat-identity':JSON.stringify(id),'content-type':'application/json'},
  body:new ReadableStream<Uint8Array>({start(c){controllers.push(c);c.enqueue(new TextEncoder().encode('{'))}}),duplex:'half',
 } as RequestInit)));
 expect((await responses.at(-1)!).status).toBe(429);
 for(const c of controllers.slice(0,32))c.close();
 expect((await Promise.all(responses.slice(0,32))).every(r=>r.status===400)).toBe(true);
 expect(await db.prepare('SELECT COUNT(*) AS count FROM chat_messages').first()).toMatchObject({count:0});
});

it('rechecks bans after slow input completion and before sending',async()=>{
 const room=fixture().room();let c!:ReadableStreamDefaultController<Uint8Array>;
 const response=room.fetch(new Request('https://chat.internal/api/chat/messages',{
  method:'POST',headers:{'x-chat-identity':JSON.stringify(identity),'content-type':'application/json'},
  body:new ReadableStream<Uint8Array>({start(controller){c=controller;c.enqueue(new TextEncoder().encode('{'))}}),duplex:'half',
 } as RequestInit));
 await db.prepare("INSERT INTO chat_bans(id,user_id,reason,created_at)VALUES('late-ban','alice','blocked',?)").bind(now).run();
 c.enqueue(new TextEncoder().encode('"requestId":"late-ban","type":"text","text":"denied"}'));c.close();
 expect((await response).status).toBe(403);
 expect(await db.prepare('SELECT COUNT(*) AS count FROM chat_messages').first()).toMatchObject({count:0});
});

it('hides unexpired cap evictions during partial child draining, including moderation lists',async()=>{
 await db.prepare("UPDATE users SET role='admin' WHERE id='alice'").run();
 await insert('oldest',0,now+100000);
 await db.prepare(`WITH RECURSIVE seq(x)AS(SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<9999)
  INSERT INTO chat_messages(id,author_display_name,content,created_at,expires_at) SELECT printf('retained-%05d',x),'test','retained',?,? FROM seq`).bind(now-1000,now+100000).run();
 await db.prepare('UPDATE chat_retention_state SET message_count=10000').run();
 await db.prepare(`WITH RECURSIVE seq(x)AS(SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<250)
  INSERT INTO chat_reports(id,message_id,reason,created_at) SELECT printf('pending-report-%03d',x),'oldest','private report',0 FROM seq`).run();
 const f=fixture(),room=f.room();
 expect((await room.fetch(request('/api/chat/messages','POST',{requestId:'at-cap',type:'text',text:'wait'}))).status).toBe(429);
 expect(await db.prepare("SELECT id FROM chat_messages WHERE id='oldest'").first()).not.toBeNull();
 expect(await db.prepare('SELECT message_count AS count FROM chat_retention_state').first()).toMatchObject({count:10000});
 const moderation=await (await room.fetch(request('/api/chat/moderation'))).json() as any;
 expect(moderation.reports).toEqual([]);
 expect((await room.fetch(request('/api/chat/moderation/messages/oldest'))).status).toBe(404);
 await room.alarm();await f.room().alarm();
 const sent=await f.room().fetch(request('/api/chat/messages','POST',{requestId:'after-cap',type:'text',text:'available'}));
 expect(sent.status).toBe(201);
 expect(await db.prepare('SELECT COUNT(*) AS count FROM chat_messages').first()).toMatchObject({count:10000});
 expect(await db.prepare('SELECT message_count AS count FROM chat_retention_state').first()).toMatchObject({count:10000});
});

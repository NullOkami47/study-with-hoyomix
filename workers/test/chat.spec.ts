import { chatRoute } from "../chat/routes";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "./miniflare-compat";
import { issueSession } from "../auth/session";
import { countryBadge, mask, text, validateFilter } from "../chat/protocol";

const origin = "https://study.example";
const secret = "community-test-secret-at-least-thirty-two-characters";
let runtime: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const tokens: Record<string, string> = {};
async function request(
  path: string,
  user = "",
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return runtime.dispatchFetch(`${origin}${path}`, {
    method,
    headers: {
      origin,
      ...(user ? { cookie: `__Host-session=${tokens[user]}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["workers/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
  });
  runtime = new Miniflare({
    modules: true,
    script: bundle.outputFiles![0].text,
    compatibilityDate: "2025-12-01",
    durableObjects: { CHAT: { className: "ChatRoom", useSQLite: true } },
    d1Databases: { DB: "chat-tests" },
    bindings: { PUBLIC_ORIGIN: origin, SESSION_HMAC_SECRET: secret },
  });
  db = await runtime.getD1Database("DB");
  for (const file of (await readdir("migrations"))
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await db.batch(
      (await readFile(`migrations/${file}`, "utf8"))
        .split(";")
        .map((sql) => sql.trim())
        .filter(Boolean)
        .map((sql) => db.prepare(sql)),
    );
  for (const [id, role] of [
    ["alice", "user"],
    ["bob", "user"],
    ["mod", "moderator"],
    ["owner", "owner"],
  ]) {
    await db
      .prepare(
        "INSERT INTO users (id,display_name,role,created_at,updated_at) VALUES (?,?,?,?,?)",
      )
      .bind(id, id, role, Date.now(), Date.now())
      .run();
    tokens[id] = (
      await issueSession(db as never, id, secret, Date.now(), crypto)
    ).token;
  }
});
afterAll(async () => {
  await runtime?.dispose();
});

describe("community chat through the native Worker and coordinator", () => {
  let messageId: string;
  it("allows anonymous bounded history and requires cookie auth and exact origin for writes", async () => {
    expect((await request("/api/chat")).status).toBe(200);
    expect(
      (
        await request("/api/chat/messages", "", "POST", {
          requestId: "noauth",
          text: "hello",
          type: "text",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          "/api/chat/messages",
          "alice",
          "POST",
          { requestId: "spoof", text: "hello", type: "text" },
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
  });
  it("commits before broadcasting, deduplicates request IDs and throttles across connections", async () => {
    const body = {
      requestId: "alice-first",
      text: "Hello community",
      type: "text",
    };
    const sent = await request("/api/chat/messages", "alice", "POST", body);
    expect(sent.status).toBe(201);
    const value = (await sent.json()) as {
      message: { id: string; content: string; role: string };
    };
    messageId = value.message.id;
    expect(value.message).toMatchObject({
      content: "Hello community",
      role: "user",
    });
    expect(
      (
        (await (
          await request("/api/chat/messages", "alice", "POST", body)
        ).json()) as { message: { id: string } }
      ).message.id,
    ).toBe(messageId);
    expect(
      (
        await request("/api/chat/messages", "alice", "POST", {
          ...body,
          requestId: "alice-second",
        })
      ).status,
    ).toBe(429);
  });
  it("enforces owner edits and records private versions", async () => {
    expect(
      (
        await request(`/api/chat/messages/${messageId}`, "bob", "PATCH", {
          text: "stolen",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/api/chat/messages/${messageId}`, "alice", "PATCH", {
          text: "Edited hello",
        })
      ).status,
    ).toBe(200);
    const versions = await db
      .prepare(
        "SELECT original_content FROM chat_message_versions WHERE message_id=?",
      )
      .bind(messageId)
      .all();
    expect(versions.results).toHaveLength(1);
    expect(
      JSON.stringify(await (await request("/api/chat")).json()),
    ).not.toContain("Hello community");
  });
  it("keeps moderation behind moderator access and masks public text without exposing originals", async () => {
    expect((await request("/api/chat/moderation", "alice")).status).toBe(403);
    expect(
      (
        await request("/api/chat/moderation", "owner", "POST", {
          action: "filter",
          filter: {
            kind: "literal",
            pattern: "Edited",
            replacement: "***",
            enabled: true,
          },
        })
      ).status,
    ).toBe(200);
    const history = JSON.stringify(await (await request("/api/chat")).json());
    expect(history).toContain("*** hello");
    expect(history).not.toContain("Edited");
    const originals = await request(
      `/api/chat/moderation/messages/${messageId}`,
      "mod",
    );
    expect(originals.status).toBe(200);
    expect(JSON.stringify(await originals.json())).toContain("Edited hello");
  });
  it("persists blocks, reports and moderator bans with audit records", async () => {
    expect(
      (await request("/api/chat/blocks", "bob", "POST", { userId: "alice" }))
        .status,
    ).toBe(200);
    expect(await (await request("/api/chat/blocks", "bob")).json()).toEqual({
      blockedUserIds: ["alice"],
    });
    expect(
      JSON.stringify(await (await request("/api/chat", "bob")).json()),
    ).not.toContain(messageId);
    expect(
      (
        await request("/api/chat/reports", "bob", "POST", {
          messageId,
          reason: "Please review",
        })
      ).status,
    ).toBe(201);
    const queue = (await (
      await request("/api/chat/moderation", "mod")
    ).json()) as { reports: unknown[] };
    expect(queue.reports).toHaveLength(1);
    expect(
      (
        await request("/api/chat/moderation", "mod", "POST", {
          action: "ban",
          userId: "alice",
          reason: "spam",
          expiresAt: null,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/api/chat/messages/${messageId}`, "alice", "PATCH", {
          text: "banned",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/chat/moderation", "mod", "POST", {
          action: "unban",
          userId: "alice",
        })
      ).status,
    ).toBe(200);
  });
  it("opens a real hibernating websocket snapshot and rejects forged/cross-origin identities", async () => {
    const bad = await request("/api/chat/socket", "", "GET", undefined, {
      upgrade: "websocket",
      origin: "https://evil.example",
    });
    expect(bad.status).toBe(403);
    const connected = await request(
      "/api/chat/socket",
      "bob",
      "GET",
      undefined,
      { upgrade: "websocket", "x-chat-identity": '{"role":"owner"}' },
    );
    expect(connected.status).toBe(101);
    const socket = connected.webSocket!;
    socket.accept();
    const snapshot = await new Promise<any>((resolve) =>
      socket.addEventListener("message", (event) => {
        if (event.data === "pong") return;
        const value = JSON.parse(String(event.data));
        if (value.type === "snapshot") resolve(value);
      }),
    );
    expect(snapshot.viewer).toEqual({ userId: "bob", role: "user" });
    expect(snapshot.participants).toBe(1);
    expect(snapshot.blockedUserIds).toEqual(["alice"]);
    const pong = new Promise((resolve) =>
      socket.addEventListener("message", (event) => {
        if (event.data === "pong") resolve(event.data);
      }),
    );
    socket.send("ping");
    expect(await pong).toBe("pong");
    socket.close();
  });
  it("rejects spoofed body metadata, unknown stickers, unsafe filters and expired edit windows", async () => {
    expect(
      (
        await request("/api/chat/messages", "bob", "POST", {
          requestId: "spoof-body",
          text: "fake",
          type: "text",
          role: "owner",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/api/chat/messages", "bob", "POST", {
          requestId: "bad-sticker",
          type: "sticker",
          stickerId: "untrusted",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/api/chat/moderation", "owner", "POST", {
          action: "filter",
          filter: { kind: "regex", pattern: "(a+)+", enabled: true },
        })
      ).status,
    ).toBe(400);
    await db
      .prepare("UPDATE chat_messages SET created_at=? WHERE id=?")
      .bind(Date.now() - 300001, messageId)
      .run();
    expect(
      (
        await request(`/api/chat/messages/${messageId}`, "alice", "PATCH", {
          text: "late",
        })
      ).status,
    ).toBe(403);
  });
  it("rejects socket write events and closes refresh floods rather than amplifying D1 reads", async () => {
    const connected = await request(
        "/api/chat/socket",
        "bob",
        "GET",
        undefined,
        { upgrade: "websocket" },
      ),
      socket = connected.webSocket!;
    socket.accept();
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code)),
    );
    socket.send(JSON.stringify({ type: "auth", role: "owner" }));
    expect(await closed).toBe(1008);
  });
  it("bounds refresh traffic and concurrent sockets per authenticated identity", async () => {
    const connections = [];
    for (let index = 0; index < 5; index++) {
      const response = await request(
        "/api/chat/socket",
        "mod",
        "GET",
        undefined,
        { upgrade: "websocket" },
      );
      expect(response.status).toBe(101);
      response.webSocket!.accept();
      connections.push(response.webSocket!);
    }
    expect(
      (
        await request("/api/chat/socket", "mod", "GET", undefined, {
          upgrade: "websocket",
        })
      ).status,
    ).toBe(429);
    const flooded = connections[0];
    const closed = new Promise<number>((resolve) =>
      flooded.addEventListener("close", (event) => resolve(event.code)),
    );
    flooded.send("refresh");
    flooded.send("refresh");
    expect(await closed).toBe(1008);
    for (const socket of connections.slice(1)) socket.close();
  });
  it("resets connected viewers after native logout and rejects the revoked session immediately", async () => {
    const response = await request(
      "/api/chat/socket",
      "owner",
      "GET",
      undefined,
      { upgrade: "websocket" },
    );
    const socket = response.webSocket!;
    socket.accept();
    const reset = new Promise((resolve) =>
      socket.addEventListener("message", (event) => {
        if (
          event.data !== "pong" &&
          JSON.parse(String(event.data)).type === "reset"
        )
          resolve(true);
      }),
    );
    expect((await request("/api/logout", "owner", "POST")).status).toBe(204);
    expect(await reset).toBe(true);
    expect((await request("/api/chat/moderation", "owner")).status).toBe(401);
    socket.close();
  });
  it("supports catalogue-validated track cards and curated stickers, never arbitrary media metadata", async () => {
    await db
      .prepare(
        "INSERT INTO catalogue_tracks(track_id,title,vocal_status,work_group_id,created_at,updated_at,published_at)VALUES('track-known','Known soundtrack','instrumental','known',1,1,1)",
      )
      .run();
    await db
      .prepare("DELETE FROM chat_send_state WHERE user_id=?")
      .bind("bob")
      .run();
    const response = await request("/api/chat/messages", "bob", "POST", {
      requestId: "known-track",
      text: "",
      type: "track",
      trackId: "track-known",
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as any).message.trackId).toBe(
      "track-known",
    );
    expect(
      (
        await request("/api/chat/messages", "bob", "POST", {
          requestId: "unknown-track",
          text: "",
          type: "track",
          trackId: "unknown",
        })
      ).status,
    ).toBe(400);
    await db
      .prepare("DELETE FROM chat_send_state WHERE user_id=?")
      .bind("bob")
      .run();
    expect(
      (
        await request("/api/chat/messages", "bob", "POST", {
          requestId: "curated-tea",
          text: "",
          type: "sticker",
          stickerId: "tea",
        })
      ).status,
    ).toBe(201);
  });
  it("bounds pagination and preserves a stable cursor for same-timestamp messages", async () => {
    expect((await request("/api/chat?limit=101")).status).toBe(400);
    expect((await request("/api/chat?before=not-valid-base64")).status).toBe(
      400,
    );
    const first = (await (await request("/api/chat?limit=1")).json()) as any;
    expect(first.messages).toHaveLength(1);
    expect(typeof first.nextCursor).toBe("string");
    const second = (await (
      await request(
        `/api/chat?limit=1&before=${encodeURIComponent(first.nextCursor)}`,
      )
    ).json()) as any;
    expect(second.messages[0].id).not.toBe(first.messages[0].id);
  });
});

describe("bounded chat protocol", () => {
  it("accepts 500 Unicode characters and rejects unpaired surrogates", () => {
    expect([...text("😀".repeat(500))]).toHaveLength(500);
    expect(() => text("\ud800")).toThrow();
  });
  it("only accepts actual ISO country badges", () => {
    expect(countryBadge("TW")).toBe("TW");
    expect(countryBadge("ZZ")).toBeNull();
    expect(countryBadge("T1")).toBeNull();
  });
  it("matches URL blacklist domains without masking unrelated hostnames or ordinary prose", () => {
    const rule = validateFilter({
      kind: "url",
      pattern: "bad.example",
      enabled: true,
    });
    expect(
      mask(
        "https://bad.example/x https://sub.bad.example/y https://notbad.example/z bad.example",
        [rule],
      ),
    ).toBe("*** *** https://notbad.example/z bad.example");
  });
});

it("bounds visitor cookie attachments to validated UUIDs at the outer Worker boundary", async () => {
  const valid = "00000000-0000-4000-8000-000000000001";
  for (const supplied of [valid, "x".repeat(3000), "a".repeat(36), ""]) {
    let forwarded: any;
    const env = {
      PUBLIC_ORIGIN: origin,
      SESSION_HMAC_SECRET: secret,
      CHAT: {
        idFromName: () => "global",
        get: () => ({
          fetch: async (request: Request) => {
            forwarded = JSON.parse(request.headers.get("x-chat-identity")!);
            return Response.json({ ok: true });
          },
        }),
      },
    };
    expect(
      (
        await chatRoute(
          new Request(`${origin}/api/chat`, {
            headers: { cookie: `__Host-presence=${supplied}` },
          }),
          env as never,
        )
      ).status,
    ).toBe(200);
    expect(forwarded.visitor).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u,
    );
    if (supplied === valid) expect(forwarded.visitor).toBe(valid);
  }
});

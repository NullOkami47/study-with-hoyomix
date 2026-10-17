import type { AuthEnv } from "../auth/routes";
import { hashSessionToken, readCookie, SESSION_COOKIE } from "../auth/session";
import type { PresenceNamespace } from "../presence";
import { countryBadge, json, type ChatIdentity } from "./protocol";

export interface ChatEnv extends AuthEnv {
  CHAT?: PresenceNamespace;
}
export async function chatRoute(
  request: Request,
  env: ChatEnv,
): Promise<Response> {
  const url = new URL(request.url);
  if (!env.CHAT) return json({ error: "chat_unavailable" }, 503);
  const socket = url.pathname === "/api/chat/socket";
  if (
    (socket || !["GET", "HEAD"].includes(request.method)) &&
    (request.headers.get("origin") !== env.PUBLIC_ORIGIN ||
      url.origin !== env.PUBLIC_ORIGIN)
  )
    return json({ error: "forbidden_origin" }, 403);
  if (
    socket &&
    (request.method !== "GET" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket")
  )
    return json({ error: "websocket_required" }, 426);
  // Only this outer boundary can read browser cookies and Cloudflare location.
  // No client-supplied identity, role, geography or visitor headers survive.
  const token = readCookie(request, SESSION_COOKIE);
  const visitor = readCookie(request, "__Host-presence");
  const validVisitor =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      visitor,
    );

  const identity: ChatIdentity = {
    sessionHash: token
      ? await hashSessionToken(token, env.SESSION_HMAC_SECRET, crypto)
      : "",
    visitor: validVisitor ? visitor : crypto.randomUUID(),
    country: countryBadge(
      (request as Request & { cf?: { country?: unknown } }).cf?.country,
    ),
    seenAt: Date.now(),
  };
  const headers = new Headers({ "x-chat-identity": JSON.stringify(identity) });
  if (socket) headers.set("upgrade", "websocket");
  if (request.headers.has("content-type"))
    headers.set("content-type", request.headers.get("content-type")!);
  const internal = new URL("https://chat.internal");
  internal.pathname = url.pathname;
  internal.search = url.search;
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, signal: request.signal };
  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = request.body;
    init.duplex = "half";
  }
  return env.CHAT.get(env.CHAT.idFromName("global")).fetch(
    new Request(internal, init),
  );
}

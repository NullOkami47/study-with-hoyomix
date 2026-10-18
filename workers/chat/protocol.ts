export type ChatRole = "user" | "moderator" | "admin" | "owner";
export interface ChatViewer {
  userId: string;
  role: ChatRole;
}
export interface ChatIdentity {
  sessionHash: string;
  visitor: string;
  country: string | null;
  seenAt: number;
  viewerKey?: string;
  refreshedAt?: number;
}
export interface ChatUser extends ChatViewer {
  displayName: string;
}
export interface ChatMessage {
  id: string;
  userId: string | null;
  displayName: string;
  role: ChatRole;
  content: string;
  type: "text" | "sticker" | "track";
  stickerId: string | null;
  trackId: string | null;
  location: string | null;
  createdAt: string;
  updatedAt: string | null;
  deletedAt: string | null;
}
export interface FilterRule {
  id: string;
  kind: "literal" | "regex" | "url";
  pattern: string;
  replacement: string;
  enabled: boolean;
}
export const STICKERS = ["tea", "focus", "cheer", "rest"] as const;
export const isModerator = (role: string) =>
  ["moderator", "admin", "owner"].includes(role);
export class ChatError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ChatError("invalid_request");
  return value as Record<string, unknown>;
};
export const text = (value: unknown, max = 500): string => {
  if (typeof value !== "string") throw new ChatError("invalid_text");
  const result = value.normalize("NFKC").trim();
  const characters = [...result];
  if (
    !result ||
    characters.length > max ||
    characters.some(
      (char) =>
        char.length === 1 &&
        char.charCodeAt(0) >= 0xd800 &&
        char.charCodeAt(0) <= 0xdfff,
    ) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)
  )
    throw new ChatError("invalid_text");
  return result;
};
export const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/u.test(value))
    throw new ChatError("invalid_id");
  return value;
};
const COUNTRIES = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " ",
  ),
);
export const countryBadge = (value: unknown): string | null =>
  typeof value === "string" && COUNTRIES.has(value) ? value : null;
export function exactKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
) {
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new ChatError("invalid_request");
}
export function validateFilter(value: unknown): FilterRule {
  const body = object(value);
  exactKeys(body, ["id", "kind", "pattern", "replacement", "enabled"]);
  if (
    !["literal", "regex", "url"].includes(String(body.kind)) ||
    typeof body.enabled !== "boolean"
  )
    throw new ChatError("invalid_filter");
  const pattern = text(body.pattern, 120);
  // Deliberately accept only finite regexes: no repetition, groups, escapes,
  // lookarounds or backreferences. This makes matching bounded by input length.
  if (body.kind === "regex") {
    if (/[\\()*+?{}]/u.test(pattern)) throw new ChatError("unsafe_regex");
    try {
      new RegExp(pattern, "giu");
    } catch {
      throw new ChatError("invalid_regex");
    }
  }
  if (
    body.kind === "url" &&
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu.test(pattern)
  )
    throw new ChatError("invalid_url_filter");
  if (body.replacement !== undefined && body.replacement !== "***")
    throw new ChatError("invalid_replacement");
  return {
    id: body.id === undefined ? crypto.randomUUID() : identifier(body.id),
    kind: body.kind as FilterRule["kind"],
    pattern,
    replacement: "***",
    enabled: body.enabled,
  };
}
export function mask(content: string, rules: FilterRule[]): string {
  let result = content.normalize("NFKC");
  for (const rule of rules) {
    if (!rule.enabled) continue;
    // Rules are also validated when reading legacy database content.
    try {
      const valid = validateFilter(rule);
      if (valid.kind === "url") {
        const domain = valid.pattern.toLowerCase();
        result = result.replace(
          /https?:\/\/[^\s<>"'\u0000-\u001f]+/giu,
          (url) => {
            try {
              const hostname = new URL(url).hostname.toLowerCase();
              return hostname === domain || hostname.endsWith(`.${domain}`)
                ? "***"
                : url;
            } catch {
              return url;
            }
          },
        );
        continue;
      }
      const pattern =
        valid.kind === "regex"
          ? valid.pattern
          : valid.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(pattern, "giu"), "***");
    } catch {
      /* Invalid legacy rules never execute arbitrary regular expressions. */
    }
  }
  return result;
}

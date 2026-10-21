import type { AssistantMessage } from "@earendil-works/pi-ai";

export type LimitKind = "subscription" | "api-budget";
export type Limit = { kind: LimitKind; resetAt?: number; resetKey?: string };

const chatgptSignals = [
  /^subscription_sharing_usage_limit_exceeded\b/i,
  /^You have hit your ChatGPT usage limit\b/i,
];

const openAiBudgetSignals = [
  /^insufficient_quota\b/i,
  /^billing_hard_limit_reached\b/i,
  /^out of budget\b/i,
];

/** Recognise only verified terminal exhaustion for the matching account mode. */
export function classifyLimit(
  message: Pick<AssistantMessage, "provider" | "stopReason" | "errorMessage">,
  now = Date.now(),
): Limit | null {
  if (message.stopReason !== "error" || !message.errorMessage) return null;

  const error = message.errorMessage.trim().replace(/^Error:\s*/i, "");
  if (message.provider === "claude-subscription") {
    if (!/^(?:Claude Code returned an error result:\s*)?You've hit your session limit(?:\s*[·•-]\s*resets\b.*)?$/i.test(error)) return null;
    const result = /^(?:Claude Code returned an error result:\s*)?You've hit your session limit\s*[·•-]\s*resets\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(([^()]{1,64})\)$/i.exec(error);
    if (!result) return { kind: "subscription" };
    const hour = Number(result[1]);
    const minute = Number(result[2]);
    const zone = result[4];
    const resetAt = parseNextLocalReset(hour, minute, result[3].toLowerCase(), zone, now);
    return resetAt === null ? { kind: "subscription" } : {
      kind: "subscription", resetAt, resetKey: `${zone}:${hour}:${minute}:${result[3].toLowerCase()}`,
    };
  }
  if (message.provider === "openai-codex" && chatgptSignals.some((signal) => signal.test(error))) {
    return { kind: "subscription" };
  }
  if (message.provider === "openai") {
    const body = error.replace(/^(?:OpenAI API error \(\d{3}\)|\d{3}):\s*/i, "");
    const code = body.startsWith("{") ? parseError(body)?.code : body;
    if (code && openAiBudgetSignals.some((signal) => signal.test(code))) {
      return { kind: "api-budget" };
    }
  }
  if (message.provider === "zai") {
    const body = error.replace(/^\d{3}:\s*/, "");
    const detail = parseError(body);
    if (detail && /^(?:1308|1310|131[6-9]|132[01])$/.test(detail.code)) {
      const resetAt = detail.message ? parseStatedReset(detail.message) : null;
      return resetAt === null ? { kind: "subscription" } : { kind: "subscription", resetAt };
    }
  }
  if (message.provider === "anthropic" && /^out of budget\b/i.test(error)) {
    return { kind: "api-budget" };
  }
  return null;
}

function parseError(body: string): { code: string; message?: string } | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return null;
    const detail = isRecord(parsed.error) ? parsed.error : parsed;
    const code = typeof detail.code === "string" ? detail.code : detail.type;
    if (typeof code !== "string") return null;
    return { code, message: typeof detail.message === "string" ? detail.message : undefined };
  } catch {
    return null;
  }
}

function parseStatedReset(message: string): number | null {
  const match = /\b(?:Your limit will reset at|Resets at)\s+(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d))(?=$|[.!?\s])/i.exec(message);
  if (!match) return null;
  const timestamp = Date.parse(match[1]);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseNextLocalReset(hour: number, minute: number, meridiem: string, zone: string, now: number): number | null {
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59 || !Number.isFinite(now)) return null;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  const targetHour = hour % 12 + (meridiem === "pm" ? 12 : 0);
  const start = Math.floor(now / 60_000) * 60_000 + 60_000;
  // The first occurrence is the next stated local time, including across DST changes.
  for (let candidate = start; candidate <= now + 49 * 60 * 60_000; candidate += 60_000) {
    const parts = formatter.formatToParts(candidate);
    const localHour = Number(parts.find((part) => part.type === "hour")?.value);
    const localMinute = Number(parts.find((part) => part.type === "minute")?.value);
    if (localHour === targetHour && localMinute === minute) return candidate;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

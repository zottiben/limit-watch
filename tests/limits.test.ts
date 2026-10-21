import { describe, expect, test } from "bun:test";
import { classifyLimit } from "../src/limits.js";

describe("classifyLimit", () => {
  test.each([
    ["openai-codex", "subscription_sharing_usage_limit_exceeded", "subscription"],
    ["openai-codex", "You have hit your ChatGPT usage limit (plus plan). Try again in ~45 min.", "subscription"],
    ["openai", "insufficient_quota: You exceeded your current quota", "api-budget"],
    ["openai", 'OpenAI API error (429): {"message":"You exceeded your current quota","code":"insufficient_quota"}', "api-budget"],
    ["openai", '429: {"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}', "api-budget"],
    ["openai", "billing_hard_limit_reached", "api-budget"],
    ["anthropic", "out of budget for this account", "api-budget"],
    ["zai", '429: {"error":{"code":"1308","message":"Usage limit reached for 5 hours"}}', "subscription"],
    ["zai", '429: {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted"}}', "subscription"],
    ["zai", '429: {"error":{"code":"1316","message":"Usage limit reached for the past 5 hours"}}', "subscription"],
  ] as const)("recognises %s: %s as %s", (provider, errorMessage, kind) => {
    expect(classifyLimit({ provider, stopReason: "error", errorMessage })).toEqual({ kind });
  });

  test.each([
    "429 Too Many Requests",
    'OpenAI API error (429): {"error":{"code":"rate_limit_exceeded","message":"insufficient_quota is a sample string"}}',
    "rate_limit_exceeded: requests per minute quota exceeded",
    "ResourceExhausted: quota exceeded for requests per minute",
    "quota exceeded",
    "available balance",
    "billing address invalid",
    "401 authentication failed",
    "500 internal error",
    "network connection lost",
    "context_length_exceeded",
    "subscription_sharing_usage_unavailable",
    "Your user request includes the words out of budget, but the error is a timeout",
  ])("leaves ordinary or ambiguous errors to Pi: %s", (errorMessage) => {
    expect(classifyLimit({ provider: "openai", stopReason: "error", errorMessage })).toBeNull();
  });

  test.each([
    ["opencode-go", "GoUsageLimitError: plan limit reached"],
    ["opencode-go", "Monthly usage limit reached"],
    ["openai", "You have hit your ChatGPT usage limit"],
    ["openai-codex", "insufficient_quota"],
    ["typesafe", "429 Too Many Requests"],
    ["zai", "1302: too many concurrent requests"],
    ["zai", '429: {"error":{"code":"1302","message":"Rate limit reached for requests"}}'],
    ["zai", '429: {"error":{"code":"1113","message":"Insufficient balance or no resource package"}}'],
    ["zai", '429: {"error":{"code":"1309","message":"Subscription expired"}}'],
    ["zai", '429: {"error":{"code":"1313","message":"Fair Usage Policy restriction"}}'],
    ["openai", '429: {"error":{"code":"1308","message":"Usage limit reached"}}'],
    ["zai-coding-cn", '429: {"error":{"code":"1308","message":"Usage limit reached"}}'],
    ["claude-subscription", "insufficient_quota"],
    ["claude-subscription", "Claude Code returned an error result: authentication failed"],
    ["anthropic", "You've hit your session limit · resets 5:50pm (Australia/Adelaide)"],
  ])("does not assign a foreign or unsupported limit to %s: %s", (provider, errorMessage) => {
    expect(classifyLimit({ provider, stopReason: "error", errorMessage })).toBeNull();
  });

  test("recognises the Claude subscription error shown in Pi, including its stated local reset", () => {
    const errorMessage = "Claude Code returned an error result: You've hit your session limit · resets 5:50pm (Australia/Adelaide)";
    const now = Date.parse("2026-10-21T03:14:20Z"); // 1:44pm Adelaide, as in the screenshot
    expect(classifyLimit({ provider: "claude-subscription", stopReason: "error", errorMessage }, now)).toEqual({
      kind: "subscription", resetAt: Date.parse("2026-10-21T07:20:00Z"), resetKey: "Australia/Adelaide:5:50:pm",
    });
    expect(classifyLimit({ provider: "claude-subscription", stopReason: "error", errorMessage: "You've hit your session limit · resets 5:50pm (Australia/Adelaide)" }, now)).toEqual({
      kind: "subscription", resetAt: Date.parse("2026-10-21T07:20:00Z"), resetKey: "Australia/Adelaide:5:50:pm",
    });
  });

  test("resolves the timezone supplied by the provider, not a hard-coded Adelaide timezone", () => {
    const now = Date.parse("2026-10-21T03:14:20Z");
    for (const [zone, reset] of [
      ["Asia/Tokyo", "2026-10-21T08:50:00Z"],
      ["Europe/London", "2026-10-21T16:50:00Z"],
      ["America/New_York", "2026-10-21T21:50:00Z"],
    ]) {
      expect(classifyLimit({ provider: "claude-subscription", stopReason: "error", errorMessage: `You've hit your session limit · resets 5:50pm (${zone})` }, now)?.resetAt).toBe(Date.parse(reset));
    }
  });

  test("recognises a Claude session limit even when its reset cannot be safely parsed", () => {
    expect(classifyLimit({ provider: "claude-subscription", stopReason: "error", errorMessage: "You've hit your session limit" })).toEqual({ kind: "subscription" });
    expect(classifyLimit({ provider: "claude-subscription", stopReason: "error", errorMessage: "You've hit your session limit · resets soon" })).toEqual({ kind: "subscription" });
    expect(classifyLimit({ provider: "claude-subscription", stopReason: "error", errorMessage: "You've hit your session limit · resets 5:50pm (Invalid/Zone)" })).toEqual({ kind: "subscription" });
  });

  test("uses the next existing local time across DST changes", () => {
    expect(classifyLimit({ provider: "claude-subscription", stopReason: "error", errorMessage: "You've hit your session limit · resets 2:30am (Australia/Adelaide)" }, Date.parse("2026-10-03T15:00:00Z"))).toEqual({
      kind: "subscription", resetAt: Date.parse("2026-10-04T16:00:00Z"), resetKey: "Australia/Adelaide:2:30:am",
    });
  });

  test("reads only an explicit timezone-qualified Z.AI reset", () => {
    expect(classifyLimit({ provider: "zai", stopReason: "error", errorMessage: '429: {"error":{"code":"1308","message":"Usage limit reached for 5 hours. Your limit will reset at 2030-01-01T12:30:00Z"}}' })).toEqual({
      kind: "subscription", resetAt: Date.parse("2030-01-01T12:30:00Z"),
    });
    expect(classifyLimit({ provider: "zai", stopReason: "error", errorMessage: '429: {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at tomorrow 12:30"}}' })).toEqual({ kind: "subscription" });
    expect(classifyLimit({ provider: "zai", stopReason: "error", errorMessage: '429: {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2030-01-01T12:30:00"}}' })).toEqual({ kind: "subscription" });
  });

  test("ignores successful and aborted responses, even if they contain limit text", () => {
    expect(classifyLimit({ provider: "openai", stopReason: "stop", errorMessage: "insufficient_quota" })).toBeNull();
    expect(classifyLimit({ provider: "openai", stopReason: "aborted", errorMessage: "insufficient_quota" })).toBeNull();
    expect(classifyLimit({ provider: "openai", stopReason: "error" })).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createLimitWatch } from "../src/index.js";
import type { WaitClock } from "../src/known-reset.js";

class FakeClock implements WaitClock {
  nowMs = Date.parse("2030-01-01T12:00:00Z");
  private nextId = 0;
  private jobs = new Map<number, { due: number; callback: () => void }>();
  now = () => this.nowMs;
  schedule = (callback: () => void, delay: number) => {
    const id = ++this.nextId;
    this.jobs.set(id, { due: this.nowMs + delay, callback });
    return () => { this.jobs.delete(id); };
  };
  advanceTo(time: number) {
    for (const [id, job] of this.jobs) {
      if (job.due <= time) {
        this.jobs.delete(id);
        this.nowMs = job.due;
        job.callback();
      }
    }
    this.nowMs = time;
  }
  get pending() { return this.jobs.size; }
}

function isExtensionUIContext(value: unknown): value is ExtensionUIContext {
  return typeof value === "object" && value !== null &&
    "theme" in value && "notify" in value && typeof value.notify === "function" &&
    "setStatus" in value && typeof value.setStatus === "function";
}

function response(model: { provider: string; id: string }, errorMessage?: string, emitStart = true) {
  const message: AssistantMessage = {
    role: "assistant",
    content: errorMessage ? [] : [{ type: "text", text: "done" }],
    api: "openai-completions",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: errorMessage ? "error" : "stop",
    errorMessage,
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  if (emitStart) stream.push({ type: "start", partial: message });
  if (errorMessage) stream.push({ type: "error", reason: "error", error: message });
  else stream.push({ type: "done", reason: "stop", message });
  stream.end();
  return stream;
}

const resetError = (resetAt: number) =>
  `429: {"error":{"code":"1308","message":"Usage limit reached for 5 hours. Your limit will reset at ${new Date(resetAt).toISOString()}"}}`;

async function withSession(
  errors: (clock: FakeClock) => (string | undefined)[],
  run: (harness: { clock: FakeClock; calls: () => number; session: Awaited<ReturnType<typeof createAgentSession>>["session"]; dispose: () => void }) => Promise<void>,
  retry = { enabled: false, maxRetries: 0, baseDelayMs: 1 },
  provider = "zai",
  notifications?: string[],
  mode: "tui" | "print" = "tui",
  emitStart = true,
) {
  const dir = mkdtempSync(join(tmpdir(), "limit-watch-sdk-"));
  const previousKey = process.env.ZAI_API_KEY;
  process.env.ZAI_API_KEY = "limit-watch-test-no-network";
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let disposed = false;
  try {
    const clock = new FakeClock();
    const replies = errors(clock);
    const model = { ...getBuiltinModel("zai", "glm-4.7"), provider, id: provider === "zai" ? "glm-4.7" : "fake-claude", baseUrl: "http://127.0.0.1:9" };
    let callCount = 0;
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      extensionFactories: [
        createLimitWatch(clock),
        (pi) => pi.registerProvider(provider, {
          api: "openai-completions",
          baseUrl: model.baseUrl,
          apiKey: "limit-watch-test-no-network",
          models: [model],
          streamSimple: (selected) => response(selected, replies[callCount++], emitStart),
        }),
      ],
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      model,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ retry, compaction: { enabled: false } }),
      noTools: "all",
    });
    session = created.session;
    const defaultUI: unknown = Reflect.get(session.extensionRunner, "uiContext");
    if (!isExtensionUIContext(defaultUI)) throw new Error("Pi SDK UI context unavailable");
    const uiContext = notifications ? { ...defaultUI, notify: (message: string) => notifications.push(message) } : undefined;
    await session.bindExtensions({ mode, uiContext });
    expect(created.extensionsResult.errors).toEqual([]);
    // Fail closed if a future Pi release stops replacing a real provider endpoint.
    expect(session.modelRuntime.getModel(provider, model.id)?.baseUrl).toBe(model.baseUrl);
    await run({ clock, calls: () => callCount, session, dispose: () => { session?.dispose(); disposed = true; } });
  } finally {
    if (session && !disposed) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    if (previousKey === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = previousKey;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function afterNextSettlement(session: Awaited<ReturnType<typeof createAgentSession>>["session"], trigger: () => void) {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error("Pi did not settle after the timer")); }, 1_000);
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_settled") {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
    trigger();
  });
}

describe("Pi extension lifecycle", () => {
  test("announces activation on TUI startup and reload without a provider request", async () => {
    const notifications: string[] = [];
    await withSession(() => [], async ({ clock, calls, session }) => {
      expect(notifications).toContain("Limit Watch enabled for this session. /limit-watch shows the current status.");
      expect(calls()).toBe(0);
      expect(clock.pending).toBe(0);
      await session.prompt("/limit-watch");
      expect(notifications).toContain("Limit Watch: enabled; no pending wait.");
      notifications.length = 0;
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
      await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      expect(notifications).toContain("Limit Watch enabled for this session. /limit-watch shows the current status.");
      expect(calls()).toBe(0);
      expect(clock.pending).toBe(0);
    }, undefined, "zai", notifications);
    notifications.length = 0;
    await withSession(() => [], async ({ calls }) => {
      expect(notifications).toEqual([]);
      expect(calls()).toBe(0);
    }, undefined, "zai", notifications, "print");
  });

  test("the Claude subscription limit in the screenshot creates a wait and resumes at 5:50pm Adelaide", async () => {
    const error = "Claude Code returned an error result: You've hit your session limit · resets 5:50pm (Australia/Adelaide)";
    await withSession((clock) => {
      clock.nowMs = Date.parse("2026-10-21T03:14:20Z");
      return [error, undefined];
    }, async ({ clock, calls, session }) => {
      const id = session.sessionManager.getSessionId();
      await session.prompt("Finish the task");
      expect(calls()).toBe(1);
      expect(clock.pending).toBe(1);
      await session.prompt("/limit-watch");
      expect(clock.pending).toBe(1);
      await afterNextSettlement(session, () => clock.advanceTo(Date.parse("2026-10-21T07:20:00Z")));
      expect(calls()).toBe(2);
      expect(session.sessionManager.getSessionId()).toBe(id);
      expect(session.getLastAssistantText()).toBe("done");
      expect(clock.pending).toBe(0);
    }, undefined, "claude-subscription");
  });

  test("a Claude bridge error without a start event still creates a visible pending wait", async () => {
    const error = "Claude Code returned an error result: You've hit your session limit · resets 5:50pm (Australia/Adelaide)";
    const notifications: string[] = [];
    await withSession((clock) => {
      clock.nowMs = Date.parse("2026-10-21T03:14:20Z");
      return [error];
    }, async ({ clock, calls, session }) => {
      await session.prompt("Finish the task");
      expect(calls()).toBe(1);
      expect(clock.pending).toBe(1);
      expect(notifications).toContain("Limit Watch: subscription limit; waiting for the stated reset. /limit-watch cancel stops it.");
    }, undefined, "claude-subscription", notifications, "tui", false);
  });

  test("can arm the last active-branch failure after /reload without another provider request", async () => {
    const error = "Claude Code returned an error result: You've hit your session limit · resets 5:50pm (Australia/Adelaide)";
    await withSession((clock) => {
      clock.nowMs = Date.parse("2026-10-21T03:14:20Z");
      return [error];
    }, async ({ clock, calls, session }) => {
      await session.prompt("Finish the task");
      await session.prompt("/limit-watch cancel");
      expect(clock.pending).toBe(0);
      await session.prompt("/limit-watch watch");
      expect(calls()).toBe(1);
      expect(clock.pending).toBe(1);
      await session.prompt("/limit-watch cancel");
      clock.advanceTo(Date.parse("2026-10-21T08:00:00Z")); // after the original reset
      await session.prompt("/limit-watch watch");
      expect(clock.pending).toBe(0); // do not invent tomorrow from a stale error
    }, undefined, "claude-subscription");
  });

  test("after reload, status identifies an earlier recognised limit and tells how to re-arm it", async () => {
    const error = "Claude Code returned an error result: You've hit your session limit · resets 5:50pm (Australia/Adelaide)";
    const notifications: string[] = [];
    await withSession((clock) => {
      clock.nowMs = Date.parse("2026-10-21T03:14:20Z");
      return [error];
    }, async ({ clock, calls, session }) => {
      await session.prompt("Finish the task");
      expect(clock.pending).toBe(1);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
      await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      expect(clock.pending).toBe(0); // reload must cancel the old timer
      notifications.length = 0;
      await session.prompt("/limit-watch");
      expect(notifications).toContain("Limit Watch: the last response was a recognised limit, but no wait is active. /limit-watch watch re-arms it without a provider request.");
      await session.prompt("/limit-watch watch");
      expect(clock.pending).toBe(1);
      expect(calls()).toBe(1);
    }, undefined, "claude-subscription", notifications);
  });

  test("/limit-watch watch ignores a prior limit after a newer successful response", async () => {
    const error = "Claude Code returned an error result: You've hit your session limit · resets 5:50pm (Australia/Adelaide)";
    await withSession((clock) => {
      clock.nowMs = Date.parse("2026-10-21T03:14:20Z");
      return [error, undefined];
    }, async ({ clock, calls, session }) => {
      await session.prompt("Finish the task");
      await session.prompt("/limit-watch cancel");
      await session.prompt("A new task");
      await session.prompt("/limit-watch watch");
      expect(calls()).toBe(2);
      expect(clock.pending).toBe(0);
    }, undefined, "claude-subscription");
  });

  test("a repeated Claude reset label after the attempt does not schedule tomorrow", async () => {
    const error = "Claude Code returned an error result: You've hit your session limit · resets 5:50pm (Australia/Adelaide)";
    await withSession((clock) => {
      clock.nowMs = Date.parse("2026-10-21T03:14:20Z");
      return [error, error];
    }, async ({ clock, calls, session }) => {
      await session.prompt("Finish the task");
      await afterNextSettlement(session, () => clock.advanceTo(Date.parse("2026-10-21T07:20:00Z")));
      expect(calls()).toBe(2);
      expect(clock.pending).toBe(0);
    }, undefined, "claude-subscription");
  });

  test("a settled Z.AI limit resumes in the same live session after its stated reset", async () => {
    await withSession((clock) => [resetError(clock.nowMs + 5_000), undefined], async ({ clock, calls, session }) => {
      const id = session.sessionManager.getSessionId();
      await session.prompt("Finish the task");
      expect(calls()).toBe(1);
      expect(clock.pending).toBe(1);
      const due = clock.nowMs + 5_000;
      clock.advanceTo(due - 1);
      expect(calls()).toBe(1);
      await afterNextSettlement(session, () => clock.advanceTo(due));
      expect(calls()).toBe(2);
      expect(session.sessionManager.getSessionId()).toBe(id);
      expect(session.getLastAssistantText()).toBe("done");
      expect(clock.pending).toBe(0);
    });
  });

  test("a still-limited attempt waits only for a new stated reset and stops after two", async () => {
    await withSession((clock) => [
      resetError(clock.nowMs + 5_000),
      resetError(clock.nowMs + 9_000),
      resetError(clock.nowMs + 20_000),
    ], async ({ clock, calls, session }) => {
      await session.prompt("Finish the task");
      await afterNextSettlement(session, () => clock.advanceTo(clock.nowMs + 5_000));
      expect(calls()).toBe(2);
      expect(clock.pending).toBe(1);
      await afterNextSettlement(session, () => clock.advanceTo(clock.nowMs + 9_000));
      expect(calls()).toBe(3);
      expect(clock.pending).toBe(0);
      clock.advanceTo(clock.nowMs + 20_000);
      expect(calls()).toBe(3);
    });
  });

  test("/limit-watch watch cannot reset the two-attempt cap during an active wait", async () => {
    await withSession((clock) => [
      resetError(clock.nowMs + 5_000),
      resetError(clock.nowMs + 9_000),
      resetError(clock.nowMs + 20_000),
    ], async ({ clock, calls, session }) => {
      await session.prompt("Finish the task");
      await afterNextSettlement(session, () => clock.advanceTo(clock.nowMs + 5_000));
      expect(clock.pending).toBe(1);
      await session.prompt("/limit-watch watch");
      await afterNextSettlement(session, () => clock.advanceTo(clock.nowMs + 9_000));
      expect(calls()).toBe(3);
      expect(clock.pending).toBe(0);
    });
  });

  test("a still-limited attempt without a new reset does not retry again", async () => {
    await withSession((clock) => [
      resetError(clock.nowMs + 5_000),
      '429: {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted"}}',
    ], async ({ clock, calls, session }) => {
      await session.prompt("Finish the task");
      await afterNextSettlement(session, () => clock.advanceTo(clock.nowMs + 5_000));
      expect(clock.pending).toBe(0);
      clock.advanceTo(clock.nowMs + 60_000);
      expect(calls()).toBe(2);
    });
  });

  test("reload, session replacement and a new user request cancel the pending timer", async () => {
    await withSession((clock) => [resetError(clock.nowMs + 5_000), undefined], async ({ clock, calls, session }) => {
      await session.prompt("Finish the task");
      expect(clock.pending).toBe(1);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
      expect(clock.pending).toBe(0);
      clock.advanceTo(clock.nowMs + 5_000);
      expect(calls()).toBe(1);
    });
    await withSession((clock) => [resetError(clock.nowMs + 5_000)], async ({ clock, calls, session }) => {
      await session.prompt("Finish the task");
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
      expect(clock.pending).toBe(0);
      clock.advanceTo(clock.nowMs + 5_000);
      expect(calls()).toBe(1);
    });
    await withSession((clock) => [resetError(clock.nowMs + 5_000), undefined], async ({ clock, calls, session }) => {
      await session.prompt("Finish the task");
      await session.prompt("/limit-watch cancel");
      expect(clock.pending).toBe(0);
      await session.prompt("New task instead");
      clock.advanceTo(clock.nowMs + 5_000);
      expect(calls()).toBe(2);
    });
  });

  test("a model selection or SDK disposal prevents a stale timer from resuming", async () => {
    await withSession((clock) => [resetError(clock.nowMs + 5_000)], async ({ clock, calls, session }) => {
      await session.prompt("Finish the task");
      const model = session.model;
      if (!model) throw new Error("Test model missing");
      await session.extensionRunner.emit({ type: "model_select", model, previousModel: model, source: "set" });
      expect(clock.pending).toBe(0);
      clock.advanceTo(clock.nowMs + 5_000);
      expect(calls()).toBe(1);
    });
    await withSession((clock) => [resetError(clock.nowMs + 5_000)], async ({ clock, calls, session, dispose }) => {
      await session.prompt("Finish the task");
      dispose();
      clock.advanceTo(clock.nowMs + 5_000);
      expect(calls()).toBe(1);
    });
  });

  test("ordinary 429 errors remain Pi's responsibility through its own retry", async () => {
    await withSession(() => ["429 Too Many Requests", undefined], async ({ clock, calls, session }) => {
      await session.prompt("Finish the task");
      expect(calls()).toBe(2);
      expect(session.getLastAssistantText()).toBe("done");
      expect(clock.pending).toBe(0);
    }, { enabled: true, maxRetries: 1, baseDelayMs: 1 });
  });

  test("a limit without an explicit reset waits for user action without polling", async () => {
    await withSession(() => ['429: {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted"}}'], async ({ clock, calls, session }) => {
      await session.prompt("Finish the task");
      expect(clock.pending).toBe(0);
      clock.advanceTo(clock.nowMs + 60_000);
      expect(calls()).toBe(1);
    });
  });
});

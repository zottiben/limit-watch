import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KnownResetWait, type WaitClock } from "./known-reset.js";
import { classifyLimit } from "./limits.js";

const STATUS_KEY = "limit-watch";
const RESUME_TYPE = "limit-watch-resume";

type Owner = { sessionId: string; modelKey: string };

function currentOwner(ctx: ExtensionContext): Owner | null {
  if (!ctx.model) return null;
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    modelKey: `${ctx.model.provider}/${ctx.model.id}`,
  };
}

export function createLimitWatch(clock?: WaitClock) {
  return function limitWatch(pi: ExtensionAPI) {
    let lastAssistant: AssistantMessage | null = null;
    let wait: KnownResetWait;
    let waitContext: ExtensionContext | null = null;
    let waitOwner: Owner | null = null;

    const clear = (ctx?: ExtensionContext) => {
      wait.cancel();
      waitContext = null;
      waitOwner = null;
      if (ctx?.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
    };

    const show = (ctx: ExtensionContext) => {
      if (ctx.mode !== "tui") return;
      const state = wait.state;
      ctx.ui.setStatus(STATUS_KEY, state.phase === "waiting"
        ? `Limit Watch: waiting until ${new Date(state.resetAt).toLocaleString()} (${state.attempts}/2 attempts)`
        : state.phase === "needs-user" ? "Limit Watch: waiting for you" : undefined);
    };

    wait = new KnownResetWait(() => {
      try {
        const ctx = waitContext;
        const owner = ctx && currentOwner(ctx);
        if (!ctx || !owner || !waitOwner || owner.sessionId !== waitOwner.sessionId ||
          owner.modelKey !== waitOwner.modelKey || !ctx.isIdle() || ctx.mode !== "tui") {
          clear(ctx ?? undefined);
          return;
        }
        pi.sendMessage({
          customType: RESUME_TYPE,
          content: "Limit Watch: the provider's stated reset time has passed. Continue the interrupted task from this session. Do not repeat completed tool actions.",
          display: true,
        }, { triggerTurn: true });
        show(ctx);
      } catch (error) {
        // SDK dispose invalidates the context without emitting session_shutdown.
        clear();
        if (error instanceof Error && error.message.includes("extension ctx is stale")) return;
        console.error("Limit Watch: automatic resume stopped:", error);
      }
    }, clock);

    pi.on("session_start", (_event, ctx) => {
      clear(ctx);
      if (ctx.mode === "tui" && ctx.hasUI) {
        ctx.ui.notify("Limit Watch enabled for this session. /limit-watch shows the current status.", "info");
      }
    });
    pi.on("session_shutdown", (_event, ctx) => clear(ctx));
    pi.on("session_tree", (_event, ctx) => clear(ctx));
    pi.on("model_select", (_event, ctx) => clear(ctx));
    pi.on("before_agent_start", (event, ctx) => {
      if (event.messageType !== "custom" || event.message.customType !== RESUME_TYPE) clear(ctx);
      lastAssistant = null;
    });
    pi.on("message_end", (event) => {
      if (event.message.role === "assistant") lastAssistant = event.message;
    });
    pi.on("agent_settled", (event, ctx) => {
      if (event.aborted) {
        clear(ctx);
        lastAssistant = null;
        return;
      }
      const message = lastAssistant;
      lastAssistant = null;
      if (!message) return;
      const owner = currentOwner(ctx);
      if (!owner) return;
      const limit = classifyLimit(message);
      if (wait.state.phase === "attempting") {
        const nextState = wait.afterAttempt(owner, limit
          ? { kind: "limited", resetAt: limit.resetAt, resetKey: limit.resetKey }
          : { kind: message.stopReason === "error" ? "other-error" : "success" });
        if (!limit && message.stopReason !== "error" && ctx.hasUI) {
          ctx.ui.notify("Limit Watch: the same session is continuing.", "info");
        }
        if (nextState.phase === "idle") {
          clear(ctx);
          return;
        }
      } else if (limit) {
        waitContext = ctx;
        waitOwner = owner;
        wait.begin(owner, ctx.mode === "tui" ? limit.resetAt : undefined, limit.resetKey);
      } else {
        return;
      }
      show(ctx);
      if (ctx.hasUI) {
        const state = wait.state;
        if (state.phase === "waiting") {
          ctx.ui.notify(`Limit Watch: ${limit?.kind ?? "subscription"} limit; waiting for the stated reset. /limit-watch cancel stops it.`, "warning");
        } else if (state.phase === "needs-user") {
          const detail = state.reason === "exhausted" ? "Two attempts reached." : "No new stated reset is available.";
          ctx.ui.notify(`Limit Watch: ${detail} Automatic attempts stopped; send a message when ready.`, "warning");
        }
      }
    });

    const lastResponseForModel = (ctx: ExtensionContext): AssistantMessage | undefined => {
      const last = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message");
      const message = last?.type === "message" ? last.message : undefined;
      return message?.role === "assistant" && message.provider === ctx.model?.provider && message.model === ctx.model.id
        ? message : undefined;
    };

    const announceWatch = (ctx: ExtensionContext) => {
      const state = wait.state;
      ctx.ui.notify(state.phase === "waiting"
        ? `Limit Watch: waiting until ${new Date(state.resetAt).toLocaleString()}. /limit-watch cancel stops it.`
        : "Limit Watch: reset time has passed or is unknown; send a message when ready.", "info");
    };

    pi.registerCommand("limit-watch", {
      description: "Show, cancel or watch the last recognised limit in this live session",
      handler: async (args, ctx) => {
        if (args.trim() === "cancel") {
          clear(ctx);
          ctx.ui.notify("Limit Watch: wait cancelled.", "info");
        } else if (args.trim() === "watch") {
          const owner = currentOwner(ctx);
          const message = lastResponseForModel(ctx);
          if (!owner || ctx.mode !== "tui" || !message) {
            ctx.ui.notify("Limit Watch: no failed response for the selected model in this session.", "warning");
            return;
          }
          const limit = classifyLimit(message, message.timestamp);
          if (!limit) {
            ctx.ui.notify("Limit Watch: the last response is not a recognised limit.", "warning");
            return;
          }
          if (wait.state.phase === "waiting" || wait.state.phase === "attempting") {
            ctx.ui.notify("Limit Watch: already watching this session; /limit-watch shows the wait.", "info");
            return;
          }
          if (wait.state.phase === "needs-user" && wait.state.attempts > 0) {
            ctx.ui.notify("Limit Watch: automatic attempts have stopped; send a message when ready.", "warning");
            return;
          }
          waitContext = ctx;
          waitOwner = owner;
          wait.begin(owner, limit.resetAt, limit.resetKey);
          show(ctx);
          announceWatch(ctx);
        } else if (!args.trim()) {
          const state = wait.state;
          const message = state.phase === "idle" ? lastResponseForModel(ctx) : undefined;
          const priorLimit = message ? classifyLimit(message, message.timestamp) : null;
          ctx.ui.notify(state.phase === "waiting"
            ? `Limit Watch: waiting until ${new Date(state.resetAt).toLocaleString()} (${state.attempts}/2 attempts).`
            : state.phase === "needs-user" ? "Limit Watch: waiting for your action; no automatic check is scheduled."
            : priorLimit?.resetAt && priorLimit.resetAt > (clock?.now() ?? Date.now())
              ? "Limit Watch: the last response was a recognised limit, but no wait is active. /limit-watch watch re-arms it without a provider request."
            : priorLimit ? "Limit Watch: the last response was a recognised limit, but no future reset is available; send a message when ready."
            : "Limit Watch: enabled; no pending wait.", "info");
        } else {
          ctx.ui.notify("Usage: /limit-watch [watch|cancel]", "warning");
        }
      },
    });
  };
}

export default createLimitWatch();

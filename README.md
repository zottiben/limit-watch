# Limit Watch

A Pi extension that recognises specific subscription and API-budget limits. In an interactive session, it waits for a stated reset and then attempts to continue the interrupted run.

## Install

```sh
pi install git:github.com/zottiben/limit-watch
```

Run `/reload` if Pi is already open. Claude subscription support requires [pi-claude-subscription](https://github.com/zottiben/pi-claude-subscription) separately.

## Behaviour

- Recognises supported exhaustion errors from Claude subscription, OpenAI Codex subscription, Anthropic API, OpenAI API, and Z.AI. Generic 429s and ordinary errors remain Pi's responsibility.
- A usable future reset schedules a continuation in the same live session. If the first attempt is still limited, a second requires a **new stated reset**; there is no third automatic attempt.
- Without a usable reset, no availability checks or model probes run. Send a message when ready to try again.
- Reload, session or model changes, cancellation, and process exit stop the pending wait. Nothing resumes after Pi exits.

## Commands

- `/limit-watch` — show the current state.
- `/limit-watch watch` — re-arm the last recognised response for the selected model (for example after a reload), without a provider request.
- `/limit-watch cancel` — cancel a pending wait.

## Development

```sh
bun install
bun run check
pi install "$(pwd)"
```

Pi loads `src/index.ts` directly; there is no build step.

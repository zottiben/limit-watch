# Limit Watch — Concept

> Status: working draft · Last updated: 2026-10-21

## Elevator pitch
A Pi extension that recognises subscription or API budget exhaustion and resumes an interrupted run when access returns, only while Pi and the affected session remain open. Initial targets: Anthropic (subscription and API), OpenAI (subscription and API), and z.ai GLM (subscription). Jev/TypeSafe is deferred.

## User promise
When a recognised limit stops a run, say what was recognised, whether a reset time is known, and what will happen next. Do not claim to be monitoring, checking, or resuming unless that behaviour is active. Never replay work after the session closes or changes. Ordinary provider, network, authentication, and tool errors are Pi's responsibility.

## Unique hook
Pi already retries transient errors (including generic 429/rate-limit failures) with bounded backoff. Limit Watch is for *exhaustion*, not short throttles: a long subscription window or exhausted API budget may require waiting longer or user intervention. It must not race Pi's built-in retry/recovery flow.

## Target audience
People running long Pi sessions on subscription or metered API models who want an interrupted run to continue once an explicit limit clears. Not for general error recovery, unattended restart across processes, or a guarantee that a purchased budget will replenish automatically.

## Core loop
A provider call fails. After Pi's automatic work settles, recognise an explicit subscription/quota/budget exhaustion signal; otherwise leave the result untouched. With a trustworthy future reset, show the wait and resume the same live session when due. Without one, wait for explicit user action by default. Offer periodic checks only when a verified free endpoint can establish actual availability; require explicit interval and maximum wait. Never use a billable model request as a probe. After a known reset, make a first continuation attempt. If it is still explicitly limited, schedule the second only if the provider states a *new* future reset time. If it gives no new reset, stop automatic retries and wait for user action; if the second attempt is also limited, stop and notify. Never retry an ordinary error. If the session changes, reloads, shuts down, the user cancels, or the chosen model changes, discard the pending resume. Never retry tool calls directly or create an invisible new session. The exact availability probe and continuation mechanism require validation against Pi's runtime before enabling automation.

## Pillars
1. **Narrow recognition** — no recovery for a generic 429 or ordinary error. *Design test:* a transient retryable error never enters Limit Watch's wait state.
2. **Honest wait** — distinguish known resets from unknown replenishment. *Design test:* no guessed countdown is shown for a budget with no reset time.
3. **Session ownership** — pending work belongs to one live session and model. *Design test:* shutdown, reload, session replacement, or model change prevents a stale timer from resuming.
4. **Visible control** — show what is pending and allow the user to stop it. *Design test:* a user can tell whether anything will run unattended.

## Anti-pillars
- NOT a replacement for Pi's bounded transient retries or context-overflow recovery.
- NOT persistent scheduling after process exit.
- NOT an unbounded polling loop hidden from the user.

## Scope & non-goals
- In scope: explicit subscription and API exhaustion, an unknown-reset preference, same-session resume and cancellation.
- Non-goals: generic error retries; restarting Pi or a closed session; npm or Pi gallery distribution; Jev/TypeSafe integration for now.

## MVP & scope tiers
- **Foundation:** package and verified recogniser with positive and negative fixtures; no automatic continuation yet.
- **MVP:** visible live-session wait/resume for known reset times, cleanup and cancellation tests; only providers whose signals and replay semantics are verified.
- **v1:** keep unknown-reset default at user action; add opt-in checks only for providers with a verified free availability endpoint, plus non-interactive behaviour.
- **Later / maybe:** more providers and more precise structured reset metadata, after collecting real examples.

## Risks & open questions
- Confirm further provider failure messages with real sessions. The Claude subscription provider reports `Claude Code returned an error result: You've hit your session limit · resets 5:50pm (Australia/Adelaide)`; this is a recognised limit, unlike a generic 429. Its time-only reset uses the next occurrence in the stated IANA timezone; if no valid time/zone is available, wait for user action. A repeated time-only label after the first attempt is not a *new* reset. Text-only messages can discard other reset metadata.
- Jev is a structured decision model, not a Pi chat/coding model ([Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents)); support is deferred, not implied by this MVP.
- Which providers expose a verified, free endpoint that indicates whether a blocked model request will work? A list-models or usage endpoint is insufficient unless it actually reflects the limiting condition. Until verified, polling is unavailable.
- The Pi SDK fake-provider test verifies same-session continuation using a custom message without directly replaying tools. Manual TUI testing still needs to check real provider behaviour after the reset.
- How should future reset timestamps be validated when absent, inaccurate, or changed?
- For unknown reset time, default to waiting for user action. If a verified free availability endpoint exists, require an explicit interval and maximum wait on each opt-in; otherwise do not offer polling.
- After a known reset, cap continuation at two attempts. The second must wait for a *new stated reset* after another recognised limit; without one, stop automatic retry and wait for user action. Verify the signal and continuation semantics in Pi before enabling this.

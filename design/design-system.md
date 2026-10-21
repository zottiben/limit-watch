# Limit Watch — Design system

> Status: working draft · Last updated: 2026-10-21

## Voice & tone
Plain, factual and brief. Say “Limit Watch: subscription limit reached; waiting until …” only with an explicit reset time; otherwise say “reset time unknown”. Never promise an API budget will replenish or a run will survive Pi's shutdown. Name the reason when monitoring stops.

## Terminal UI surfaces
Use Pi's existing notification/status/command surfaces rather than a custom component. On interactive session start or reload, announce that Limit Watch is enabled; do not imply that availability polling is active. `/limit-watch` confirms enabled/idle state or shows a pending wait; if a prior recognised limit remains on the active branch after reload, explain that no wait is active and offer `/limit-watch watch` to explicitly re-arm it without another provider request. `/limit-watch cancel` stops an active wait. A status indicator should identify a live wait, not imply progress. A passed or unknown reset leaves the user in control. Check exact wording in the running TUI.

## Colour tokens
Use Pi's theme semantics through existing UI methods. No custom colour palette.

## Typography & spacing
Not applicable until a custom component is justified.

## Components & states
- **Known reset / waiting:** describe the explicit reset and how to cancel; no countdown based on a guess. After a still-limited first attempt, wait only for a newly stated reset. If none is supplied, stop automatic attempts and wait for user action; after a still-limited second attempt, stop with a clear notice.
- **Unknown reset / waiting for user (default):** say no automatic check is scheduled and what user action can resume.
- **Unknown reset / periodic checking (future opt-in):** show this option only when a verified free availability endpoint exists; say which checks run and at what explicitly selected interval and bound.
- **Checking:** describe only checks actually performed; avoid noisy repeat notices.
- **Resumed:** confirm that the same session is continuing.
- **Cancelled / replaced / shut down:** clear status and timers; do not report a future resume.
- **Failed / unrecognised:** leave to Pi, without a misleading wait notice.

## Accessibility & non-interactive modes
Do not require a TUI dialog to classify an error. In RPC, JSON and print modes, avoid silent scheduled activity; any enabled behaviour must have an observable event or message and a cancellation path. Confirm the supported UI protocol and mode before implementing non-interactive auto-resume.

## Usage rules
Known-reset waits may run in an interactive Pi session only, with a visible status and `/limit-watch cancel`; an old error is never rearmed automatically on reload. The unknown-reset default is user action; do not offer background polling without a verified free availability endpoint. Never use a billable model request as a probe. Add a conformance check when the terminal UI is finalized.

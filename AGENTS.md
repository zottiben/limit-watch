# Limit Watch — project knowledge

A public Pi extension that watches subscription and API usage limits and resumes an interrupted run when access is available again.

**Stack:** TypeScript Pi package; Bun for development. Pi loads extension `.ts` source directly, without a build step.

**Layout**
- `src/` — limit recognition, known-reset scheduling, and the Pi extension.
- `tests/` — classifier, scheduler, and isolated Pi SDK tests.
- `design/` — product intent and terminal interaction decisions.
- `.agents/` — installed ai-toolbox hooks and helper skills.

**Commands** (from repo root)
- Development install: `pi install "$(pwd)"` — loads the local checkout; `/reload` picks up source changes.
- User install (once published): `pi install git:github.com/zottiben/limit-watch` — no npm or Pi gallery listing planned.
- Dev server: none; the extension runs inside Pi.
- Install dependencies: `bun install`; typecheck: `bun run typecheck`; tests: `bun run test`; combined gate: `bun run check`. No lint script yet.
- Build / codegen: none; Pi loads `src/index.ts` directly via the package's `pi.extensions` manifest.
- Release: TODO; do not assume the release process from the reference project.

## Design

The design guide in `design/` records product boundaries and terminal interaction decisions. Ask when a decision isn't covered and record it there. Key docs: `design/concept.md` and `design/design-system.md`.

## Hard rules

- **Resume only recognised limits.** Treat subscription/quota/budget exhaustion separately from ordinary errors, which remain Pi's responsibility. Cover both paths with tests.
- **Live session only.** Resume only while Pi and the affected session remain open; stop pending timers/checks on session shutdown, reload or replacement. Do not promise recovery after process exit or machine restart. Cover cancellation with tests.
- **Unknown reset time is a user preference.** Default to waiting for user action after an API budget limit. Permit opt-in periodic availability checks only via a verified free endpoint that reflects actual availability, with an explicit interval and maximum wait. Never send billable model requests as probes; until a free endpoint exists, do not offer polling. Test both paths when polling is implemented.
- **Limit post-reset attempts.** Make at most two continuation attempts. If the first is still limited, wait for a *new stated reset* before the second; without one, stop automatic retries and wait for user action. After the second still-limited attempt, stop and notify. Never retry ordinary errors.
- **Provider scope.** Target Anthropic subscription/API, OpenAI subscription/API, and z.ai GLM subscription. Jev is deferred. Verify provider-specific failure signals before enabling recovery; a generic 429 is not exhaustion.
- **Keep Pi host libraries external.** Declare Pi-supplied packages as peers (and dev dependencies if needed), not bundled runtime dependencies; duplicate runtime copies can break extension loading. Check the manifest before release.

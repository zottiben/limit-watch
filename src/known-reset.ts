export type WaitClock = {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
};

type Owner = { sessionId: string; modelKey: string };
type AttemptResult = { kind: "success" | "other-error" } | { kind: "limited"; resetAt?: number; resetKey?: string };
export type WaitState =
  | { phase: "idle" }
  | { phase: "waiting"; attempts: number; resetAt: number }
  | { phase: "attempting"; attempts: number }
  | { phase: "needs-user"; attempts: number; reason: "no-reset" | "no-new-reset" | "exhausted" };

const MAX_TIMER_MS = 2_147_483_647;
const realClock: WaitClock = {
  now: Date.now,
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** One live session's known-reset attempts. The caller owns model/session cancellation. */
export class KnownResetWait {
  private current: WaitState = { phase: "idle" };
  private owner: Owner | null = null;
  private lastReset: number | null = null;
  private lastResetKey: string | null = null;
  private stopTimer: (() => void) | null = null;
  private generation = 0;

  constructor(
    private readonly onAttempt: (attempt: number) => void,
    private readonly clock: WaitClock = realClock,
  ) {}

  get state(): WaitState {
    return this.current;
  }

  begin(owner: Owner, resetAt?: number, resetKey?: string): void {
    this.cancel();
    this.owner = { ...owner };
    if (!this.isFuture(resetAt)) {
      this.current = { phase: "needs-user", attempts: 0, reason: "no-reset" };
      return;
    }
    this.waitUntil(resetAt, 0, resetKey);
  }

  afterAttempt(owner: Owner, result: AttemptResult): WaitState {
    if (!this.isOwner(owner) || this.current.phase !== "attempting") return this.current;
    const attempts = this.current.attempts;
    if (result.kind !== "limited") {
      this.cancel();
    } else if (attempts >= 2) {
      this.current = { phase: "needs-user", attempts, reason: "exhausted" };
    } else if (this.isFuture(result.resetAt) && result.resetAt > (this.lastReset ?? 0) &&
      (!result.resetKey || result.resetKey !== this.lastResetKey)) {
      this.waitUntil(result.resetAt, attempts, result.resetKey);
    } else {
      this.current = { phase: "needs-user", attempts, reason: "no-new-reset" };
    }
    return this.current;
  }

  cancel(): void {
    this.stopTimer?.();
    this.stopTimer = null;
    this.generation++;
    this.current = { phase: "idle" };
    this.owner = null;
    this.lastReset = null;
    this.lastResetKey = null;
  }

  private isOwner(owner: Owner): boolean {
    return this.owner?.sessionId === owner.sessionId && this.owner.modelKey === owner.modelKey;
  }

  private isFuture(timestamp: number | undefined): timestamp is number {
    return timestamp !== undefined && Number.isFinite(timestamp) && timestamp > this.clock.now();
  }

  private waitUntil(resetAt: number, attempts: number, resetKey?: string): void {
    this.lastReset = resetAt;
    this.lastResetKey = resetKey ?? null;
    this.current = { phase: "waiting", attempts, resetAt };
    const generation = ++this.generation;
    const arm = () => {
      if (generation !== this.generation || this.current.phase !== "waiting") return;
      const remaining = resetAt - this.clock.now();
      if (remaining > 0) {
        this.stopTimer = this.clock.schedule(arm, Math.min(remaining, MAX_TIMER_MS));
      } else {
        this.stopTimer = null;
        this.current = { phase: "attempting", attempts: attempts + 1 };
        this.onAttempt(attempts + 1);
      }
    };
    arm();
  }
}

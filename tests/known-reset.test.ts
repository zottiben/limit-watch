import { describe, expect, test } from "bun:test";
import { KnownResetWait, type WaitClock } from "../src/known-reset.js";

class FakeClock implements WaitClock {
  nowMs = 1_000;
  private nextId = 1;
  readonly timers = new Map<number, { due: number; callback: () => void }>();
  now = () => this.nowMs;
  setTimeout = (callback: () => void, delay: number) => {
    const id = this.nextId++;
    this.timers.set(id, { due: this.nowMs + delay, callback });
    return id;
  };
  clearTimeout = (id: number) => { this.timers.delete(id); };
  schedule = (callback: () => void, delay: number) => {
    const id = this.setTimeout(callback, delay);
    return () => this.clearTimeout(id);
  };
  advanceTo(time: number) {
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > time) break;
      this.nowMs = next[1].due;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.nowMs = time;
  }
}

const owner = { sessionId: "session-1", modelKey: "zai/glm" };

function setup() {
  const clock = new FakeClock();
  const attempts: number[] = [];
  const wait = new KnownResetWait((attempt) => { attempts.push(attempt); }, clock);
  return { clock, attempts, wait };
}

describe("known reset wait", () => {
  test("waits for each newly stated reset and never makes a third attempt", () => {
    const { clock, attempts, wait } = setup();
    wait.begin(owner, 5_000);
    clock.advanceTo(4_999);
    expect(attempts).toEqual([]);
    clock.advanceTo(5_000);
    expect(attempts).toEqual([1]);
    wait.afterAttempt(owner, { kind: "limited", resetAt: 8_000 });
    clock.advanceTo(8_000);
    expect(attempts).toEqual([1, 2]);
    wait.afterAttempt(owner, { kind: "limited", resetAt: 12_000 });
    expect(wait.state).toEqual({ phase: "needs-user", attempts: 2, reason: "exhausted" });
    clock.advanceTo(12_000);
    expect(attempts).toEqual([1, 2]);
  });

  test("no new future reset means no second automatic attempt", () => {
    const { clock, attempts, wait } = setup();
    wait.begin(owner, 5_000);
    clock.advanceTo(5_000);
    wait.afterAttempt(owner, { kind: "limited" });
    expect(wait.state).toEqual({ phase: "needs-user", attempts: 1, reason: "no-new-reset" });
    clock.advanceTo(100_000);
    expect(attempts).toEqual([1]);
    wait.begin(owner, 110_000);
    clock.advanceTo(110_000);
    wait.afterAttempt(owner, { kind: "limited", resetAt: 110_000 });
    expect(attempts).toEqual([1, 1]);
    expect(clock.timers.size).toBe(0);
  });

  test("a repeated local-time label is not a new stated reset even if parsed as tomorrow", () => {
    const { clock, attempts, wait } = setup();
    wait.begin(owner, 5_000, "Australia/Adelaide:5:50:pm");
    clock.advanceTo(5_000);
    wait.afterAttempt(owner, { kind: "limited", resetAt: 5_000 + 24 * 60 * 60_000, resetKey: "Australia/Adelaide:5:50:pm" });
    expect(wait.state).toEqual({ phase: "needs-user", attempts: 1, reason: "no-new-reset" });
    expect(clock.timers.size).toBe(0);
    expect(attempts).toEqual([1]);
  });

  test("unknown, malformed or past reset defaults to user action", () => {
    const { clock, attempts, wait } = setup();
    for (const reset of [undefined, NaN, Infinity, 999]) {
      wait.begin(owner, reset);
      expect(wait.state).toEqual({ phase: "needs-user", attempts: 0, reason: "no-reset" });
      expect(clock.timers.size).toBe(0);
    }
    clock.advanceTo(100_000);
    expect(attempts).toEqual([]);
  });

  test("other error or success ends the wait and does not schedule more work", () => {
    const { clock, wait } = setup();
    wait.begin(owner, 5_000);
    clock.advanceTo(5_000);
    wait.afterAttempt(owner, { kind: "other-error" });
    expect(wait.state).toEqual({ phase: "idle" });
    wait.begin(owner, 7_000);
    clock.advanceTo(7_000);
    wait.afterAttempt(owner, { kind: "success" });
    expect(wait.state).toEqual({ phase: "idle" });
  });

  test("cancellation and owner mismatch prevent stale session/model work", () => {
    const { clock, attempts, wait } = setup();
    wait.begin(owner, 5_000);
    const stale = [...clock.timers.values()][0].callback;
    wait.cancel();
    stale();
    clock.advanceTo(5_000);
    expect(attempts).toEqual([]);
    wait.begin(owner, 8_000);
    clock.advanceTo(8_000);
    wait.afterAttempt({ ...owner, sessionId: "replacement" }, { kind: "limited", resetAt: 10_000 });
    expect(wait.state).toEqual({ phase: "attempting", attempts: 1 });
    wait.cancel();
    expect(clock.timers.size).toBe(0);
  });

  test("long waits are rearmed without exceeding the timer limit", () => {
    const { clock, attempts, wait } = setup();
    const due = clock.nowMs + 2_147_483_647 + 500;
    wait.begin(owner, due);
    expect([...clock.timers.values()][0].due).toBe(clock.nowMs + 2_147_483_647);
    clock.advanceTo(due - 1);
    expect(attempts).toEqual([]);
    clock.advanceTo(due);
    expect(attempts).toEqual([1]);
  });
});

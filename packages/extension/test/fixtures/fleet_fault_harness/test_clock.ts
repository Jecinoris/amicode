// ============================================================================
// #1049 F-harness — the controllable test clock (spec-20260913-114814 §8).
//
// The harness's injectable time source: `now()` is a fake monotone instant,
// `advance(ms)` fires due scheduled callbacks in deadline order (same-deadline
// in registration order) — never a real timer, never a real wait. Time only
// moves through `advance`; a callback scheduled during an advance fires inside
// the same advance if its deadline is still due. Negative advance is refused:
// time never runs backward.
//
// `Lease` is the representative lease/scheduling consumer (the F5 checkout-race
// fixtures use it): held → expired at exactly `issue + ttl` on the injected
// clock, renew re-holds from the renewal instant, `onExpiry` fires through the
// clock at the exact expiry instant — zero wall-clock waiting anywhere.
// ============================================================================

export type ClockTimerHandle = { readonly id: number };

export type ClockTimerCallback = () => void;

export class FakeClock {
  private t: number;
  private nextId = 0;
  // Deadline-ordered on demand; insertion order preserved for same-deadline ties.
  private timers: { id: number; deadline: number; cb: ClockTimerCallback }[] = [];

  constructor(epoch = 0) {
    this.t = epoch;
  }

  now(): number {
    return this.t;
  }

  setTimeout(cb: ClockTimerCallback, delayMs: number): ClockTimerHandle {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error(`FakeClock.setTimeout: delayMs must be a non-negative finite number, got ${delayMs}`);
    }
    const id = this.nextId++;
    this.timers.push({ id, deadline: this.t + delayMs, cb });
    return { id };
  }

  clearTimeout(handle: ClockTimerHandle): void {
    this.timers = this.timers.filter((tm) => tm.id !== handle.id);
  }

  /** The earliest pending deadline (absolute clock time), or null if idle. */
  pending(): number | null {
    if (this.timers.length === 0) return null;
    return this.timers.reduce((min, tm) => (tm.deadline < min ? tm.deadline : min), this.timers[0].deadline);
  }

  /**
   * Move the clock forward by `ms`, firing every timer whose deadline falls
   * within (now, now+ms] in deadline order; ties fire in registration order.
   * A callback scheduled mid-advance participates in the same advance if its
   * deadline is still due. Each callback observes now() == its deadline.
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`FakeClock.advance: time never runs backward (got ${ms})`);
    }
    const target = this.t + ms;
    for (;;) {
      let due: (typeof this.timers)[number] | undefined;
      for (const tm of this.timers) {
        if (tm.deadline <= target && (due === undefined || tm.deadline < due.deadline)) {
          due = tm;
        }
      }
      if (due === undefined) break;
      this.t = due.deadline;
      // Fire ALL timers at this exact deadline, in registration order.
      const batch = this.timers.filter((tm) => tm.deadline === due!.deadline);
      this.timers = this.timers.filter((tm) => tm.deadline !== due!.deadline);
      for (const tm of batch) tm.cb();
    }
    this.t = target;
  }
}

export type LeaseState = "held" | "expired";

export type LeaseOptions = {
  clock: FakeClock;
  holder: string;
  ttlMs: number;
};

/**
 * A lease driven entirely by the injected clock: expiry is exact (now >=
 * issuedAt + ttl), renewal extends from the renewal instant, and `onExpiry`
 * callbacks fire through the clock at the exact expiry instant.
 */
export class Lease {
  readonly holder: string;
  private readonly clock: FakeClock;
  private readonly ttlMs: number;
  private expiryAt: number;
  private expiryCallbacks: ClockTimerCallback[] = [];

  constructor(opts: LeaseOptions) {
    this.clock = opts.clock;
    this.holder = opts.holder;
    this.ttlMs = opts.ttlMs;
    this.expiryAt = this.clock.now() + this.ttlMs;
  }

  state(): LeaseState {
    return this.clock.now() >= this.expiryAt ? "expired" : "held";
  }

  remainingMs(): number {
    return Math.max(0, this.expiryAt - this.clock.now());
  }

  /** Re-hold: a fresh TTL counted from the renewal instant (works from expired too). */
  renew(): void {
    this.expiryAt = this.clock.now() + this.ttlMs;
  }

  /** Fire `cb` through the clock at the exact expiry instant. */
  onExpiry(cb: ClockTimerCallback): void {
    this.expiryCallbacks.push(cb);
    const delay = this.expiryAt - this.clock.now();
    if (delay <= 0) {
      cb();
      return;
    }
    this.clock.setTimeout(() => cb(), delay);
  }
}

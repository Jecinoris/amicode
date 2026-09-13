import { describe, it, expect } from "vitest";
import { FakeClock, Lease } from "./fixtures/fleet_fault_harness/test_clock";

// ============================================================================
// #1049 F-harness — the controllable test clock (spec-20260913-114814 §8,
// F-harness deliverable; AC2: "The test clock advances time deterministically;
// a lease-expiry scenario can be driven to expiry and back with zero
// wall-clock waiting").
//
// The clock is the harness's injectable time source: `now()` is a fake
// monotone instant, `advance(ms)` fires due scheduled callbacks in
// deadline order (same-deadline in registration order) — never a real
// timer, never a real wait. The Lease is the representative lease/scheduling
// consumer (the F5 checkout-race fixtures consume it) driven entirely by the
// injected clock.
// ============================================================================

describe("FakeClock — deterministic time source", () => {
  it("starts at 0 (or a given epoch) and now() only moves by advance()", () => {
    const c = new FakeClock();
    expect(c.now()).toBe(0);
    c.advance(5000);
    expect(c.now()).toBe(5000);
    const epoch = new FakeClock(10_000);
    expect(epoch.now()).toBe(10_000);
  });

  it("fires a scheduled timer when advanced past its deadline", () => {
    const c = new FakeClock();
    const fired: number[] = [];
    c.setTimeout(() => fired.push(c.now()), 100);
    c.advance(99);
    expect(fired).toEqual([]);
    c.advance(1);
    expect(fired).toEqual([100]); // callback sees now() == its deadline
  });

  it("fires due timers in DEADLINE order regardless of registration order", () => {
    const c = new FakeClock();
    const order: string[] = [];
    c.setTimeout(() => order.push("late-registered-early-deadline"), 10);
    c.setTimeout(() => order.push("early-registered-late-deadline"), 20);
    c.advance(100);
    expect(order).toEqual(["late-registered-early-deadline", "early-registered-late-deadline"]);
  });

  it("fires same-deadline timers in REGISTRATION order", () => {
    const c = new FakeClock();
    const order: string[] = [];
    c.setTimeout(() => order.push("a"), 50);
    c.setTimeout(() => order.push("b"), 50);
    c.setTimeout(() => order.push("c"), 50);
    c.advance(50);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("a timer scheduled DURING advance fires inside the same advance if still due", () => {
    const c = new FakeClock();
    const order: string[] = [];
    c.setTimeout(() => {
      order.push("one");
      c.setTimeout(() => order.push("chained@+5"), 5);
    }, 10);
    c.setTimeout(() => order.push("two@20"), 20);
    c.advance(30);
    // chained (deadline 15) fires before the 20-deadline timer, inside one advance
    expect(order).toEqual(["one", "chained@+5", "two@20"]);
  });

  it("clearTimeout prevents the callback from ever firing", () => {
    const c = new FakeClock();
    let fired = 0;
    const h = c.setTimeout(() => fired++, 10);
    c.clearTimeout(h);
    c.advance(1000);
    expect(fired).toBe(0);
  });

  it("advance(0) fires exactly-due timers and nothing else", () => {
    const c = new FakeClock();
    const fired: number[] = [];
    c.setTimeout(() => fired.push(10), 10);
    c.advance(10);
    c.advance(0);
    c.setTimeout(() => fired.push(15), 5);
    c.advance(0);
    expect(fired).toEqual([10]);
  });

  it("negative advance is refused loudly (determinism: time never runs backward)", () => {
    const c = new FakeClock();
    expect(() => c.advance(-1)).toThrow();
  });

  it("pending(deadline) reports the next due time (for probe timeouts)", () => {
    const c = new FakeClock();
    c.setTimeout(() => {}, 100);
    c.setTimeout(() => {}, 40);
    expect(c.pending()).toBe(40);
  });
});

describe("Lease — clock-driven expiry, zero wall-clock waiting (AC2)", () => {
  it("drives a lease to expiry and back with zero wall-clock waiting", () => {
    const realStart = Date.now(); // proof-of-no-wait, not synchronization
    const c = new FakeClock();
    const lease = new Lease({ clock: c, holder: "macbook", ttlMs: 30_000 });

    expect(lease.state()).toBe("held");
    expect(lease.remainingMs()).toBe(30_000);

    c.advance(29_999);
    expect(lease.state()).toBe("held"); // one ms before expiry — still held

    c.advance(1);
    expect(lease.state()).toBe("expired"); // exactly at TTL — expired
    expect(lease.remainingMs()).toBe(0);

    // "and back": renew from an expired lease re-holds it for a fresh TTL
    c.advance(120_000);
    lease.renew();
    expect(lease.state()).toBe("held");
    expect(lease.remainingMs()).toBe(30_000);

    c.advance(30_000);
    expect(lease.state()).toBe("expired");

    // a renewal mid-life extends from the RENEWAL instant, not the issue instant
    const second = new Lease({ clock: c, holder: "mini", ttlMs: 10_000 });
    c.advance(5000);
    second.renew();
    expect(second.remainingMs()).toBe(10_000);
    c.advance(9999);
    expect(second.state()).toBe("held");
    c.advance(1);
    expect(second.state()).toBe("expired");

    // AC2's "zero wall-clock waiting": the whole lifecycle consumed no real time
    expect(Date.now() - realStart).toBeLessThan(1000);
  });

  it("expires via a clock SCHEDULED callback (the unattended-loop shape: no polling)", () => {
    const c = new FakeClock();
    const events: string[] = [];
    const lease = new Lease({ clock: c, holder: "erlich", ttlMs: 1000 });
    lease.onExpiry(() => events.push(`expired@${c.now()}`));

    c.advance(999);
    expect(events).toEqual([]);
    c.advance(1);
    expect(events).toEqual(["expired@1000"]); // fired at the exact expiry instant
    expect(lease.state()).toBe("expired");
  });
});

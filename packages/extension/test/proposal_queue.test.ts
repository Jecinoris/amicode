// #1092 (fleet rearchitect P4a-3, D2 — the FULL queue rule): the proposal
// queue — durable device-local staged proposals, drain-before-verify at the
// engine's onVerifyEntry seam, idempotent applies by portable request
// identity (invariant 5), the blocked-degraded rule, and the serialization
// hold through the engine's verify→commit window.
//
// The contract under test (spec spec-20260913-114814 §0.1 mutations of
// consequence, D2, §2.2 row 3, §8 F9 — the fixture row is the matrix):
//   · The store is device-local + durable + crash-safe: write-temp-rename,
//     injectable path, a deterministic kill mid-write leaves the PRIOR file
//     intact, zero wall-clock (FakeClock drives every retry/backoff).
//   · The record carries: type (the §0.1 enumerated set + row-3's
//     structural-surface), payload, request identity = content hash +
//     confirm stamp (PORTABLE across devices — the dedupe key), the fleet
//     verb contract version, state (staged | blocked-degraded |
//     pending-reconfirm).
//   · Drain-before-verify: the queue drains FULLY at onVerifyEntry, BEFORE
//     the mode machine's verify begins; a throwing drain leaves the
//     transition STAGED (the engine's pinned behavior, asserted here from
//     the queue side too).
//   · Reconnect re-verify: precondition CHANGE → pending-reconfirm, NEVER
//     applied; a fetch failure is NOT a world change: blocked-degraded +
//     posture degraded + bounded retry + NO rename to pending-reconfirm.
//   · Blocked-degraded never wedges the drain: a fetch-blocked proposal
//     ahead of a mode proposal does not block the locally-verifiable ones.
//   · Idempotent applies: a duplicate apply by identical request identity
//     is a no-op returning the prior result — n_duplicate_applies == 0,
//     including the two-device double-confirm case.
//   · The serialization hold: while the engine is between verify and
//     commit, applies are held until the commit resolves — the two
//     machines never interleave (asserted impossible, not merely avoided).
//   · Structural events enqueue: the classifier's auth-revoked and
//     presumed-structural typed events land as staged proposals; nothing
//     beyond emission+enqueue happens offline.
//   · Applies carry the fleet verb contract version; a stale-contract
//     apply is rejected loudly naming BOTH versions (consuming
//     @amicode/schema's contract semantics — never re-defined here).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModeMachine,
  ModeTransitionEngine,
  type VerifyOutcome,
} from "../src/amicode_service/attach_state";
import {
  ProposalQueue,
  ProposalStore,
  PROPOSAL_TYPES,
  PROPOSAL_STATES,
  identityKeyOf,
  queueDrainHook,
  queueHoldHook,
  type ProposalEnqueueInput,
  type ProposalExecutor,
  type QueuedProposal,
} from "../src/amicode_service/proposal_queue";
import { FLEET_CONTRACT_VERSION } from "@amicode/schema";
import { TransportClassifier } from "../src/amicode_service/transport_classifier";
import { KillHookRegistry, SimulatedCrash } from "./fixtures/fleet_fault_harness/kill_hook";
import { FakeClock } from "./fixtures/fleet_fault_harness/test_clock";

// ── the test rig ──────────────────────────────────────────────────────────────

/** A hub-like apply target: executes each portable identity AT MOST ONCE and
 *  returns the prior result for a re-confirm — the versioned verb contract's
 *  idempotency surface (invariant 5). Real executors arrive with P3b-2/P6;
 *  the mock models the contract they will implement. If the queue stamped
 *  applies with a device-local identity, the two-device double-confirm would
 *  fork identities and double-execute — exactly what nDuplicateApplies detects. */
class HubLikeExecutor implements ProposalExecutor {
  private readonly executions = new Map<string, { count: number; result: unknown }>();
  readonly applied: QueuedProposal[] = [];

  apply(proposal: QueuedProposal): unknown {
    const key = identityKeyOf(proposal.identity);
    const prior = this.executions.get(key);
    if (prior !== undefined) {
      return prior.result; // the contract dedupes by portable identity: never re-executes
    }
    const result = { ok: true, appliedType: proposal.type, payload: proposal.payload };
    this.executions.set(key, { count: 1, result });
    this.applied.push(proposal);
    return result;
  }

  /** Distinct identities executed at least once. */
  executionCount(): number {
    return this.executions.size;
  }

  /** The F9 metric: executions beyond the FIRST for one identity. */
  nDuplicateApplies(): number {
    let n = 0;
    for (const rec of this.executions.values()) n += rec.count - 1;
    return n;
  }
}

interface Rig {
  machine: ModeMachine;
  clock: FakeClock;
  hub: HubLikeExecutor;
  store: ProposalStore;
  queue: ProposalQueue;
  storePath: string;
  root: string;
}

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    const root = roots.pop()!;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
});

interface RigOpts {
  storePath?: string;
  hooks?: KillHookRegistry;
  fetchTruth?: (proposal: QueuedProposal) => Promise<unknown> | unknown;
  config?: { maxRetries?: number; retryBaseDelayMs?: number; retryMaxDelayMs?: number };
}

function newQueue(
  machine: ModeMachine,
  store: ProposalStore,
  executor: ProposalExecutor,
  clock: FakeClock,
  fetchTruth: (proposal: QueuedProposal) => Promise<unknown> | unknown,
  config: { maxRetries: number; retryBaseDelayMs: number; retryMaxDelayMs: number },
): ProposalQueue {
  return new ProposalQueue({ machine, store, executor, fetchTruth, clock, config });
}

function rigQueue(opts: RigOpts = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "amicode-1092-proposal-queue-"));
  roots.push(root);
  const storePath = opts.storePath ?? join(root, "proposal-queue.json");
  const clock = new FakeClock();
  const machine = new ModeMachine({ now: () => new Date(clock.now()).toISOString() });
  const hub = new HubLikeExecutor();
  const store = new ProposalStore({
    path: storePath,
    ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
  });
  const config = {
    maxRetries: opts.config?.maxRetries ?? 3,
    retryBaseDelayMs: opts.config?.retryBaseDelayMs ?? 100,
    retryMaxDelayMs: opts.config?.retryMaxDelayMs ?? 400,
  };
  // the default truth: the world matches every staged precondition
  const fetchTruth = opts.fetchTruth ?? ((p: QueuedProposal) => p.precondition.expected);
  const queue = newQueue(machine, store, hub, clock, fetchTruth, config);
  return { machine, clock, hub, store, queue, storePath, root };
}

/** TWO devices (machine/store/clock each), ONE shared hub-like apply target. */
function rigDevicePair() {
  const sharedHub = new HubLikeExecutor();
  const mk = (): Rig => {
    const base = rigQueue();
    const queue = newQueue(
      base.machine,
      base.store,
      sharedHub,
      base.clock,
      (p) => p.precondition.expected,
      { maxRetries: 3, retryBaseDelayMs: 100, retryMaxDelayMs: 400 },
    );
    return { ...base, hub: sharedHub, queue };
  };
  return { deviceA: mk(), deviceB: mk(), sharedHub };
}

const CONFIRM_STAMP = "human-confirm-2026-09-13T12:00:00Z-0001";

/** A deterministic microtask pump — latches a condition that only resolves
 *  through promise chains (never a real timer, zero wall-clock). */
async function until(cond: () => boolean, hops = 500): Promise<void> {
  for (let i = 0; i < hops && !cond(); i++) await Promise.resolve();
  expect(cond(), "condition never latched (microtask pump exhausted)").toBe(true);
}

function modeProposalInput(overrides: Partial<ProposalEnqueueInput> = {}): ProposalEnqueueInput {
  return {
    type: "mode-change",
    payload: { to: "fleet", reason: "enroll: human-confirmed proposal" },
    precondition: { claim: "hub-lists-device", expected: { devices: ["mini", "macbook"] } },
    confirmStamp: CONFIRM_STAMP,
    ...overrides,
  };
}

function fleetWriteInput(overrides: Partial<ProposalEnqueueInput> = {}): ProposalEnqueueInput {
  return {
    type: "fleet-write",
    payload: { session: "hub-session-42", bytes: "the write-intent bytes" },
    precondition: { claim: "session-hub-resident", expected: { resident: true } },
    confirmStamp: CONFIRM_STAMP,
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// AC 1 — the store: durable, crash-safe, injectable path, zero wall-clock
// ══════════════════════════════════════════════════════════════════════════════

describe("#1092 the proposal store — durable, crash-safe, injectable, zero wall-clock", () => {
  it("enqueue persists durably: a FRESH store instance (the process-restart story) reads the same proposals", () => {
    const { queue, storePath } = rigQueue();
    queue.enqueue(modeProposalInput());
    queue.enqueue(fleetWriteInput());

    const restarted = new ProposalStore({ path: storePath });
    const file = restarted.load();
    expect(file.version).toBe(1);
    expect(file.proposals.map((p) => p.type)).toEqual(["mode-change", "fleet-write"]);
    expect(file.proposals.every((p) => p.state === "staged")).toBe(true);
  });

  it("a deterministic kill at mid-write (pre-rename, crash) leaves the PRIOR file intact — the reload reads the prior content", () => {
    const hooks = new KillHookRegistry();
    const { queue, storePath } = rigQueue({ hooks });
    const first = queue.enqueue(modeProposalInput()); // clean save (unarmed)
    expect(first.deduped).toBe(false);

    // the second save dies mid-write: tmp written, the rename never happened
    hooks.arm("pre-rename", { kind: "crash" });
    expect(() => queue.enqueue(fleetWriteInput())).toThrow(SimulatedCrash);

    const restarted = new ProposalStore({ path: storePath });
    const file = restarted.load();
    expect(file.proposals.length).toBe(1); // the prior file, intact
    expect(file.proposals[0].id).toBe(first.proposal!.id);
    expect(hooks.fired).toEqual([{ point: "pre-rename", kind: "crash" }]);
  });

  it("a stop at pre-rename halts the save BEFORE the rename: the prior file intact, the orphaned tmp never loads", () => {
    const hooks = new KillHookRegistry();
    const { queue, storePath } = rigQueue({ hooks });
    queue.enqueue(modeProposalInput()); // clean save (unarmed)
    const before = readFileSync(storePath, "utf8");

    hooks.arm("pre-rename", { kind: "stop" });
    queue.enqueue(fleetWriteInput()); // halted mid-write — silent return, no rename

    expect(readFileSync(storePath, "utf8")).toBe(before); // the prior file intact
    expect(existsSync(`${storePath}.tmp`)).toBe(true); // the orphaned tmp
    const restarted = new ProposalStore({ path: storePath });
    expect(restarted.load().proposals.length).toBe(1); // the tmp never loads
  });

  it("the path is injectable (never the home dir) and a corrupt or unversioned store file fails LOUD — never a silent reset", () => {
    const { storePath } = rigQueue();
    writeFileSync(storePath, "not-json-{", "utf8");
    expect(() => new ProposalStore({ path: storePath }).load()).toThrow(/corrupt|JSON/i);

    writeFileSync(storePath, JSON.stringify({ version: 99, proposals: [], applied: [] }), "utf8");
    expect(() => new ProposalStore({ path: storePath }).load()).toThrow(/version/i);
  });

  it("receipts persist too — an applied identity survives the restart as the dedupe ledger", async () => {
    const { queue, storePath } = rigQueue();
    const { proposal } = queue.enqueue(modeProposalInput());
    await queue.drain();
    const key = identityKeyOf(proposal!.identity);

    const restarted = new ProposalStore({ path: storePath });
    const file = restarted.load();
    expect(file.proposals.length).toBe(0);
    expect(file.applied.map((r) => r.identityKey)).toEqual([key]);
    expect(file.applied[0].result).toMatchObject({ ok: true, appliedType: "mode-change" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC 2 — the record: the §0.1 type set, portable identity, contract version
// ══════════════════════════════════════════════════════════════════════════════

describe("#1092 the proposal record — §0.1 types, portable identity, contract version, states", () => {
  it("the record carries type/payload/precondition, identity = content hash + confirm stamp, the fleet verb contract version, state staged", () => {
    const { queue } = rigQueue();
    const { proposal } = queue.enqueue(modeProposalInput());

    expect(proposal!.type).toBe("mode-change");
    expect(proposal!.payload).toEqual({ to: "fleet", reason: "enroll: human-confirmed proposal" });
    expect(proposal!.precondition).toEqual({
      claim: "hub-lists-device",
      expected: { devices: ["mini", "macbook"] },
    });
    // request identity = proposal content hash + the ORIGINAL confirm stamp
    expect(proposal!.identity.confirmStamp).toBe(CONFIRM_STAMP);
    expect(proposal!.identity.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(proposal!.contractVersion).toBe(FLEET_CONTRACT_VERSION);
    expect(proposal!.state).toBe("staged");
    expect(typeof proposal!.id).toBe("string");
  });

  it("the §0.1 enumerated type set is closed: mode-change, checkout, return, fleet-write, topology-edit — plus row-3's structural-surface", () => {
    expect(PROPOSAL_TYPES).toEqual([
      "mode-change", // §0.1: mode changes (enroll/detach)
      "checkout", // §0.1: checkout
      "return", // §0.1: return
      "fleet-write", // §0.1: fleet writes to hub-resident sessions
      "topology-edit", // §0.1: device enrollment / topology edits
      "structural-surface", // row 3: the escalation surface (never auto-applied)
    ]);
    expect(PROPOSAL_STATES).toEqual(["staged", "blocked-degraded", "pending-reconfirm"]);
  });

  it("the request identity is PORTABLE: the same confirm on a second device yields the identical identity key (local ids differ)", () => {
    const { deviceA, deviceB } = rigDevicePair();
    const a = deviceA.queue.enqueue(modeProposalInput());
    const b = deviceB.queue.enqueue(modeProposalInput());

    expect(a.proposal!.id).not.toBe(b.proposal!.id); // local record ids differ
    expect(identityKeyOf(b.proposal!.identity)).toBe(identityKeyOf(a.proposal!.identity)); // the identity travels
    expect(b.proposal!.identity.contentHash).toBe(a.proposal!.identity.contentHash);
    expect(b.proposal!.identity.confirmStamp).toBe(a.proposal!.identity.confirmStamp);
  });

  it("a differing payload or confirm stamp is a DIFFERENT identity — the hash covers the content, never a device id", () => {
    const { queue } = rigQueue();
    const a = queue.enqueue(modeProposalInput());
    const b = queue.enqueue(modeProposalInput({ payload: { to: "fleet", reason: "edited" } }));
    const c = queue.enqueue(modeProposalInput({ confirmStamp: "a-second-confirm" }));
    expect(identityKeyOf(b.proposal!.identity)).not.toBe(identityKeyOf(a.proposal!.identity));
    expect(identityKeyOf(c.proposal!.identity)).not.toBe(identityKeyOf(a.proposal!.identity));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC 3 — drain-before-verify at the engine's onVerifyEntry seam
// ══════════════════════════════════════════════════════════════════════════════

describe("#1092 drain-before-verify — the queue drains fully at onVerifyEntry, BEFORE mode verify", () => {
  it("the queue drains FULLY before the attach test: applies land first, every proposal rests before verify begins", async () => {
    const r = rigQueue();
    const order: string[] = [];
    const statesAtAttachTest: string[] = [];
    const recordingExecutor: ProposalExecutor = {
      apply: (p) => {
        order.push(`apply:${p.type}`);
        return r.hub.apply(p);
      },
    };
    const queue = newQueue(
      r.machine,
      r.store,
      recordingExecutor,
      r.clock,
      (p) => (p.precondition.claim === "world-changed" ? { devices: ["mini"] } : p.precondition.expected),
      { maxRetries: 3, retryBaseDelayMs: 100, retryMaxDelayMs: 400 },
    );
    const engine = new ModeTransitionEngine({
      machine: r.machine,
      verify: () => {
        order.push("attach-test");
        statesAtAttachTest.push(...queue.proposals().map((p) => p.state));
        return { kind: "pass" } as VerifyOutcome;
      },
      clock: r.clock,
      onVerifyEntry: queueDrainHook(queue),
    });

    queue.enqueue(modeProposalInput());
    queue.enqueue(
      modeProposalInput({
        precondition: { claim: "world-changed", expected: { devices: ["mini", "macbook"] } },
        confirmStamp: "confirm-changed-world",
      }),
    );

    engine.stage({ to: "fleet" });
    await engine.verify();

    // the apply and the re-verify verdict BOTH landed before the attach test
    expect(order).toEqual(["apply:mode-change", "attach-test"]);
    // the changed-world proposal rests at pending-reconfirm BEFORE verify began
    expect(statesAtAttachTest).toEqual(["pending-reconfirm"]);
    expect(r.hub.executionCount()).toBe(1);
  });

  it("a THROWING drain leaves the transition STAGED — nothing journaled for the attempt (the pinned engine behavior, from the queue side)", async () => {
    const r = rigQueue();
    r.queue.enqueue(modeProposalInput());
    // corrupt the durable store: the drain's load dies loudly
    writeFileSync(r.storePath, "corrupt-{", "utf8");
    // a fresh queue over the same corrupt file — the drain throws on entry
    const queue2 = newQueue(
      r.machine,
      new ProposalStore({ path: r.storePath }),
      r.hub,
      r.clock,
      (p) => p.precondition.expected,
      { maxRetries: 3, retryBaseDelayMs: 100, retryMaxDelayMs: 400 },
    );
    const engine = new ModeTransitionEngine({
      machine: r.machine,
      verify: () => ({ kind: "pass" }),
      clock: r.clock,
      onVerifyEntry: queueDrainHook(queue2),
    });
    engine.stage({ to: "fleet" });
    const journalBefore = r.machine.journal().length;

    await expect(engine.verify()).rejects.toThrow(/corrupt|JSON/i);
    expect(engine.state()).toBe("staged"); // the pinned behavior, queue side
    expect(r.machine.journal().length).toBe(journalBefore); // nothing journaled for the attempt
    expect(r.machine.read().mode).toBe("standalone"); // nothing applied
    expect(r.hub.executionCount()).toBe(0); // no apply leaked
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC 4 — reconnect re-verify: D2's full rule
// ══════════════════════════════════════════════════════════════════════════════

describe("#1092 reconnect re-verify — precondition change vs fetch failure (D2's full rule)", () => {
  it("a precondition CHANGE → pending-reconfirm, NEVER applied", async () => {
    const { queue, hub } = rigQueue({
      fetchTruth: () => ({ devices: ["mini"] }), // the world changed: macbook left
    });
    const { proposal } = queue.enqueue(modeProposalInput());

    const report = await queue.drain();
    expect(report.pendingReconfirm).toEqual([proposal!.id]);
    expect(queue.proposals()[0].state).toBe("pending-reconfirm");
    expect(hub.executionCount()).toBe(0); // NEVER applied
    expect(queue.receipts().length).toBe(0);

    // a second drain never re-fetches a pending-reconfirm: only a human
    // re-confirm (a fresh confirm stamp = a new identity) revives it
    const again = await queue.drain();
    expect(again.pendingReconfirm).toEqual([proposal!.id]);
    expect(hub.executionCount()).toBe(0);
  });

  it("a fetch failure mid-re-verify → blocked-degraded + posture degraded + bounded retry scheduled + NO rename to pending-reconfirm", async () => {
    const { queue, machine, clock } = rigQueue({
      fetchTruth: () => {
        throw new Error("fetch died: the tunnel is down");
      },
      config: { maxRetries: 2, retryBaseDelayMs: 100, retryMaxDelayMs: 200 },
    });
    const { proposal } = queue.enqueue(modeProposalInput());

    const report = await queue.drain();
    expect(report.blockedDegraded).toEqual([proposal!.id]);
    const stored = queue.proposals()[0];
    expect(stored.state).toBe("blocked-degraded"); // marked, still queued
    expect(stored.state).not.toBe("pending-reconfirm"); // a fetch failure is NOT a world change
    expect(stored.lastError).toContain("fetch died");
    expect(stored.attempts).toBe(1);
    // posture degraded — through the machine's posture path (render-only)
    expect(machine.read().posture).toBe("degraded");
    // bounded retry scheduled on the FakeClock: a timer is pending at the backoff delay
    expect(clock.pending()).toBe(100);
  });

  it("the bounded retry is FakeClock-driven: the backoff re-attempts, the budget exhausts, the proposal stays blocked-degraded (surfaced, never wedging)", async () => {
    let fetches = 0;
    const { queue, machine, clock } = rigQueue({
      fetchTruth: () => {
        fetches++;
        throw new Error("fetch died");
      },
      config: { maxRetries: 2, retryBaseDelayMs: 100, retryMaxDelayMs: 200 },
    });
    const { proposal } = queue.enqueue(modeProposalInput());

    await queue.drain(); // attempt 1 fails → retry timer at +100
    clock.advance(100); // the backoff fires the retry drain
    await queue.idle(); // → attempt 2 fails
    expect(fetches).toBe(2);
    expect(queue.proposals()[0].state).toBe("blocked-degraded");
    expect(queue.proposals()[0].attempts).toBe(2);

    // the budget is exhausted: no further fetch attempts, no further timers
    expect(clock.pending()).toBeNull();
    const third = await queue.drain(); // a later drain SKIPS it — surfaced, not re-fetched
    expect(fetches).toBe(2);
    expect(third.blockedDegraded).toEqual([proposal!.id]);
    expect(queue.proposals()[0].state).toBe("blocked-degraded");

    // the queue never RESTORES posture — recovery is the transport
    // classifier's path, never the queue's
    expect(machine.read().posture).toBe("degraded");
  });

  it("a fetch that HEALS: the next retry re-verifies against fresh truth and applies", async () => {
    let failing = true;
    const { queue, clock, hub } = rigQueue({
      fetchTruth: () => {
        if (failing) throw new Error("fetch died");
        return { devices: ["mini", "macbook"] };
      },
      config: { maxRetries: 3, retryBaseDelayMs: 100, retryMaxDelayMs: 200 },
    });
    const { proposal } = queue.enqueue(modeProposalInput());
    await queue.drain(); // blocked-degraded
    failing = false;
    clock.advance(100); // the retry drain re-verifies against fresh truth
    await queue.idle();
    expect(queue.proposals().length).toBe(0); // applied — the blocked state cleared
    expect(hub.executionCount()).toBe(1);
    expect(queue.receipts().map((r) => r.identityKey)).toEqual([identityKeyOf(proposal!.identity)]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC 5 — blocked-degraded never wedges the drain
// ══════════════════════════════════════════════════════════════════════════════

describe("#1092 blocked-degraded never wedges the drain", () => {
  it("a fetch-blocked proposal AHEAD of a mode proposal does not block the locally-verifiable ones", async () => {
    const { queue, hub, clock } = rigQueue({
      fetchTruth: (p) => {
        // the mode proposal is LOCALLY verifiable (its truth is local state,
        // fetched without the dead transport); the fleet-write hits the hub
        if (p.type === "mode-change") return { devices: ["mini", "macbook"] };
        throw new Error("hub fetch died");
      },
      config: { maxRetries: 3, retryBaseDelayMs: 100, retryMaxDelayMs: 200 },
    });
    const blocked = queue.enqueue(fleetWriteInput()); // ahead in queue order
    const mode = queue.enqueue(modeProposalInput());

    const report = await queue.drain();
    expect(report.blockedDegraded).toEqual([blocked.proposal!.id]);
    expect(report.applied).toEqual([mode.proposal!.id]); // the mode proposal APPLIED
    expect(hub.executionCount()).toBe(1);
    expect(hub.applied[0].type).toBe("mode-change");
    expect(clock.pending()).toBe(100); // the blocked one's retry is scheduled
    // the blocked entry surfaces individually
    expect(queue.proposals().map((p) => [p.type, p.state])).toEqual([
      ["fleet-write", "blocked-degraded"],
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC 6 — idempotent applies by portable identity (invariant 5)
// ══════════════════════════════════════════════════════════════════════════════

describe("#1092 idempotent applies — a duplicate apply is a no-op returning the prior result", () => {
  it("a re-confirm of an ALREADY-APPLIED identity is a no-op returning the prior result — the executor sees it once, n_duplicate_applies == 0", async () => {
    const { queue, hub } = rigQueue();
    queue.enqueue(modeProposalInput());
    await queue.drain();
    expect(hub.executionCount()).toBe(1);
    const priorResult = queue.receipts()[0].result;

    // the duplicate re-confirm (the same content + the same confirm stamp)
    const dup = queue.enqueue(modeProposalInput());
    expect(dup.alreadyApplied).toBe(true);
    expect(dup.priorResult).toEqual(priorResult); // the prior result, returned
    expect(dup.proposal).toBeNull(); // nothing re-staged
    expect(hub.executionCount()).toBe(1); // the executor was NEVER re-called
    expect(queue.stats().n_duplicate_applies).toBe(0);

    // and the drain is a no-op for it too
    const report = await queue.drain();
    expect(report.applied).toEqual([]);
    expect(hub.executionCount()).toBe(1);
    expect(queue.stats().n_duplicate_applies).toBe(0);
  });

  it("a re-confirm of an already-STAGED identity dedupes at enqueue — one queued record, never two", () => {
    const { queue } = rigQueue();
    const first = queue.enqueue(modeProposalInput());
    const dup = queue.enqueue(modeProposalInput());
    expect(dup.deduped).toBe(true);
    expect(dup.proposal!.id).toBe(first.proposal!.id); // the SAME record
    expect(queue.proposals().length).toBe(1);
  });

  it("the two-device double-confirm (F9 row 4): both devices confirm offline; the shared apply target executes ONCE — n_duplicate_applies == 0 everywhere", async () => {
    const { deviceA, deviceB, sharedHub } = rigDevicePair();
    const a = deviceA.queue.enqueue(modeProposalInput());
    const b = deviceB.queue.enqueue(modeProposalInput()); // the same confirm, second device

    const reportA = await deviceA.queue.drain();
    const reportB = await deviceB.queue.drain();

    expect(reportA.applied).toEqual([a.proposal!.id]);
    expect(reportB.applied).toEqual([b.proposal!.id]); // B's drain applied too — idempotently
    // the shared apply target executed the identity EXACTLY ONCE
    expect(sharedHub.executionCount()).toBe(1);
    expect(sharedHub.nDuplicateApplies()).toBe(0);
    // both devices' queues report zero duplicate applies
    expect(deviceA.queue.stats().n_duplicate_applies).toBe(0);
    expect(deviceB.queue.stats().n_duplicate_applies).toBe(0);
    // device B's receipt carries the PRIOR result — the dedupe returned it
    expect(deviceB.queue.receipts()[0].result).toEqual(deviceA.queue.receipts()[0].result);
    // both devices' stores record the same portable identity key
    expect(deviceB.queue.receipts()[0].identityKey).toBe(deviceA.queue.receipts()[0].identityKey);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC 7 — the serialization hold: the engine's verify→commit window
// ══════════════════════════════════════════════════════════════════════════════

describe("#1092 the serialization hold — applies held through the engine's verify→commit window", () => {
  function rigWindow() {
    const base = rigQueue();
    const events: { phase: string; reason: string }[] = [];
    const order: string[] = [];
    const recordingExecutor: ProposalExecutor = {
      apply: (p) => {
        order.push(`apply:${p.type}`);
        return base.hub.apply(p);
      },
    };
    const queue = newQueue(
      base.machine,
      base.store,
      recordingExecutor,
      base.clock,
      (p) => p.precondition.expected,
      { maxRetries: 3, retryBaseDelayMs: 100, retryMaxDelayMs: 400 },
    );
    let resolveAttach!: () => void;
    const attachGate = new Promise<void>((r) => {
      resolveAttach = r;
    });
    const windowHook = (phase: "open" | "closed", reason: string) => {
      events.push({ phase, reason });
      queueHoldHook(queue)(phase, reason);
    };
    const engine = new ModeTransitionEngine({
      machine: base.machine,
      verify: async () => {
        order.push("attach-test");
        await attachGate;
        order.push("attach-settled");
        return { kind: "pass" } as VerifyOutcome;
      },
      clock: base.clock,
      onVerifyEntry: queueDrainHook(queue),
      onCommitWindow: windowHook,
    });
    return { ...base, queue, engine, events, order, resolveAttach, windowHook };
  }

  it("the additive engine hook: the window OPENS after the drain (before the attach test) and CLOSES when the commit resolves", async () => {
    const r = rigWindow();
    r.engine.stage({ to: "fleet" });
    const verifyPromise = r.engine.verify();
    // the verify-entry drain runs, then the window opens, then the attach
    // test gates — latch it without wall-clock (the gate holds verify open)
    await until(() => r.events.length === 1);
    expect(r.events.map((e) => e.phase)).toEqual(["open"]); // open before the attach test settled
    expect(r.order).toEqual(["attach-test"]); // the attach test started and gated
    r.resolveAttach();
    await verifyPromise;
    r.engine.commit();
    expect(r.events.map((e) => e.phase)).toEqual(["open", "closed"]);
    expect(r.events[1].reason).toMatch(/commit/);
  });

  it("applies arriving DURING the window are HELD — the executor sees nothing until the commit resolves; the interleaving is impossible, not merely avoided", async () => {
    const r = rigWindow();
    r.engine.stage({ to: "fleet" });
    const verifyPromise = r.engine.verify();
    // let the verify-entry drain run (empty queue), the window open, and the
    // attach test gate — deterministically, zero wall-clock
    await until(() => r.order.includes("attach-test"));
    expect(r.events.map((e) => e.phase)).toEqual(["open"]);

    // a proposal lands and a drain is triggered mid-window (a retry timer or
    // a fresh enqueue path — the same machinery)
    r.queue.enqueue(modeProposalInput());
    const held = await r.queue.drain();
    expect(held.held).toEqual([r.queue.proposals()[0].id]); // deferred by the hold
    expect(r.hub.executionCount()).toBe(0); // NOTHING reached the executor mid-window
    expect(r.order).not.toContain("apply:mode-change"); // the interleaving never happened

    r.resolveAttach();
    await verifyPromise;
    r.engine.commit(); // the commit resolves → window CLOSED → the release drain

    await r.queue.idle();
    // the apply landed strictly AFTER the commit resolved
    expect(r.order).toEqual(["attach-test", "attach-settled", "apply:mode-change"]);
    expect(r.hub.executionCount()).toBe(1);
    expect(r.events.map((e) => e.phase)).toEqual(["open", "closed"]);
  });

  it("the window closes on every non-pass settle: transient-fail, structural-fail, and the budget expiry", async () => {
    // transient-fail
    {
      const r = rigWindow();
      const events: { phase: string; reason: string }[] = [];
      const engine = new ModeTransitionEngine({
        machine: r.machine,
        verify: () => ({ kind: "transient-fail", detail: "timeout" }),
        clock: r.clock,
        onVerifyEntry: queueDrainHook(r.queue),
        onCommitWindow: (phase, reason) => events.push({ phase, reason }),
      });
      engine.stage({ to: "fleet" });
      await engine.verify();
      expect(events.map((e) => e.phase)).toEqual(["open", "closed"]);
    }
    // structural-fail (closes after the automatic rollback)
    {
      const r = rigWindow();
      const events: { phase: string; reason: string }[] = [];
      const engine = new ModeTransitionEngine({
        machine: r.machine,
        verify: () => ({ kind: "structural-fail", detail: "mode changed elsewhere" }),
        clock: r.clock,
        onVerifyEntry: queueDrainHook(r.queue),
        onCommitWindow: (phase, reason) => events.push({ phase, reason }),
      });
      engine.stage({ to: "fleet" });
      await engine.verify();
      expect(events.map((e) => e.phase)).toEqual(["open", "closed"]);
    }
    // budget expiry
    {
      const r = rigWindow();
      const events: { phase: string; reason: string }[] = [];
      const engine = new ModeTransitionEngine({
        machine: r.machine,
        verify: () => new Promise<VerifyOutcome>(() => {}), // never settles
        clock: r.clock,
        onVerifyEntry: queueDrainHook(r.queue),
        onCommitWindow: (phase, reason) => events.push({ phase, reason }),
      });
      engine.stage({ to: "fleet" });
      const pending = engine.verify();
      r.clock.advance(60_000); // the #1034 floor — FakeClock-driven
      await pending;
      expect(events.map((e) => e.phase)).toEqual(["open", "closed"]);
    }
  });

  it("a mid-commit halt keeps the window OPEN until the pending transition resolves (resume → closed; force-abort → closed)", async () => {
    // resume closes
    {
      const hooks = new KillHookRegistry();
      hooks.arm("mid-commit", { kind: "stop" });
      const r = rigWindow();
      const events: { phase: string; reason: string }[] = [];
      const engine = new ModeTransitionEngine({
        machine: r.machine,
        verify: () => ({ kind: "pass" }),
        clock: r.clock,
        hooks,
        onVerifyEntry: queueDrainHook(r.queue),
        onCommitWindow: (phase, reason) => events.push({ phase, reason }),
      });
      engine.stage({ to: "fleet" });
      await engine.verify();
      engine.commit(); // halted mid-commit — the window STAYS open
      expect(events.map((e) => e.phase)).toEqual(["open"]);
      hooks.disarm("mid-commit");
      engine.resume();
      expect(events.map((e) => e.phase)).toEqual(["open", "closed"]);
    }
    // force-abort closes too
    {
      const hooks = new KillHookRegistry();
      hooks.arm("mid-commit", { kind: "stop" });
      const r = rigWindow();
      const events: { phase: string; reason: string }[] = [];
      const engine = new ModeTransitionEngine({
        machine: r.machine,
        verify: () => ({ kind: "pass" }),
        clock: r.clock,
        hooks,
        onCommitWindow: (phase, reason) => events.push({ phase, reason }),
      });
      engine.stage({ to: "fleet" });
      await engine.verify();
      engine.commit(); // halted mid-commit
      engine.forceResolvePending("abort");
      expect(events.map((e) => e.phase)).toEqual(["open", "closed"]);
    }
  });

  it("a FRESH engine recovering a journaled commit-pending re-asserts the open window at recovery (the hold survives the crash)", async () => {
    const hooks = new KillHookRegistry();
    hooks.arm("mid-commit", { kind: "crash" });
    const r = rigWindow();
    const events: { phase: string; reason: string }[] = [];
    const engine = new ModeTransitionEngine({
      machine: r.machine,
      verify: () => ({ kind: "pass" }),
      clock: r.clock,
      hooks,
      onCommitWindow: (phase, reason) => events.push({ phase, reason }),
    });
    engine.stage({ to: "fleet" });
    await engine.verify();
    expect(() => engine.commit()).toThrow(SimulatedCrash);
    expect(events.map((e) => e.phase)).toEqual(["open"]); // the window never closed

    // process death → a FRESH engine recovers commit-pending from the journal
    const engine2 = new ModeTransitionEngine({
      machine: r.machine,
      verify: () => ({ kind: "pass" }),
      clock: r.clock,
      onCommitWindow: (phase, reason) => events.push({ phase, reason }),
    });
    expect(engine2.state()).toBe("commit-pending");
    expect(events.map((e) => e.phase)).toEqual(["open", "open"]); // recovery re-asserts the open window
    engine2.forceResolvePending("resume");
    expect(events.map((e) => e.phase)).toEqual(["open", "open", "closed"]);
  });

  it("WITHOUT the hook the engine's behavior is unchanged — the sanctioned change is purely additive", async () => {
    const base = rigQueue();
    const engine = new ModeTransitionEngine({
      machine: base.machine,
      verify: () => ({ kind: "pass" }),
      clock: base.clock,
      onVerifyEntry: queueDrainHook(base.queue),
      // no onCommitWindow at all
    });
    engine.stage({ to: "fleet" });
    const out = await engine.verify();
    expect(out.kind).toBe("pass");
    engine.commit();
    expect(base.machine.read().mode).toBe("fleet"); // the existing lifecycle intact
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC 8 — structural events enqueue proposals (row 3)
// ══════════════════════════════════════════════════════════════════════════════

describe("#1092 structural events enqueue — auth-revoked and presumed-structural land as staged proposals", () => {
  function rigWithClassifier() {
    const r = rigQueue();
    const classifier = new TransportClassifier({
      machine: r.machine,
      nowMs: () => r.clock.now(),
      config: { escalationCapMs: 1_000 },
    });
    return { ...r, classifier };
  }

  it("auth-revoked lands as a staged structural-surface proposal; NOTHING beyond emission+enqueue happens offline", () => {
    const r = rigWithClassifier();
    r.classifier.noteAuthRevoked("401 from the hub write pipeline");

    const proposals = r.queue.proposals();
    expect(proposals.length).toBe(1);
    const p = proposals[0];
    expect(p.type).toBe("structural-surface");
    expect(p.payload).toMatchObject({ class: "auth-revoked" });
    expect(p.state).toBe("staged");
    expect(r.hub.executionCount()).toBe(0); // never auto-applied
    // nothing beyond emission+enqueue: no posture write, no mode write, no journal
    expect(r.machine.read().posture).toBe("ok");
    expect(r.machine.read().mode).toBe("standalone");
    expect(r.machine.journal().length).toBe(0);
    expect(r.machine.transportModeWriteCount()).toBe(0);
    // and the emission itself is on the machine's structural log
    expect(r.machine.structuralEvents().map((e) => e.class)).toContain("auth-revoked");
  });

  it("presumed-structural (the classifier's FakeClock-driven escalation) lands as a staged proposal", () => {
    const r = rigWithClassifier();
    r.classifier.record({ kind: "no-response", fault: "timeout" }); // transient → degraded
    r.clock.advance(1_001); // time-since-last-successful-fetch past the cap
    r.classifier.record({ kind: "no-response", fault: "timeout" }); // the escalation fires

    const proposals = r.queue.proposals();
    expect(proposals.length).toBe(1);
    expect(proposals[0].type).toBe("structural-surface");
    expect(proposals[0].payload).toMatchObject({ class: "presumed-structural" });
    expect(r.hub.executionCount()).toBe(0);
  });

  it("structural-surface proposals are NEVER auto-applied: the drain re-verifies — retained while the claim persists, resolved when the world recovered", async () => {
    let authStillRevoked = true;
    const r = rigQueue();
    const classifier = new TransportClassifier({ machine: r.machine, nowMs: () => r.clock.now() });
    const queue = newQueue(
      r.machine,
      r.store,
      r.hub,
      r.clock,
      () => (authStillRevoked ? { class: "auth-revoked" } : { class: "auth-ok" }),
      { maxRetries: 3, retryBaseDelayMs: 100, retryMaxDelayMs: 400 },
    );
    classifier.noteAuthRevoked("401");
    const p = queue.proposals()[0];

    // the claim persists → retained (surfaced for the human), never executed
    const first = await queue.drain();
    expect(first.surfaceRetained).toEqual([p.id]);
    expect(queue.proposals()[0].state).toBe("staged");
    expect(r.hub.executionCount()).toBe(0);

    // the world recovered → resolved and dropped, with a receipt
    authStillRevoked = false;
    const second = await queue.drain();
    expect(second.surfaceResolved).toEqual([p.id]);
    expect(queue.proposals().length).toBe(0);
    expect(queue.receipts()[0].identityKey).toBe(identityKeyOf(p.identity));
    expect(r.hub.executionCount()).toBe(0); // still never executed
  });

  it("a repeated identical identity dedupes at enqueue — one queued record per identity", () => {
    const r = rigWithClassifier();
    r.machine.emitStructural({ class: "auth-revoked", detail: "401" });
    expect(r.queue.proposals().length).toBe(1);
    const first = r.queue.proposals()[0];
    // the same identity (same content + same stamp) → deduped at enqueue
    const dup = r.queue.enqueue({
      type: "structural-surface",
      payload: { class: "auth-revoked", detail: "401" },
      precondition: first.precondition,
      confirmStamp: first.identity.confirmStamp,
    });
    expect(dup.deduped).toBe(true);
    expect(r.queue.proposals().length).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC 9 — the versioned verb contract on applies
// ══════════════════════════════════════════════════════════════════════════════

describe("#1092 the fleet verb contract version on applies — stale contracts rejected loudly", () => {
  it("applies carry the contract version; a stale-contract apply is rejected loudly naming BOTH versions, never executed, never wedging the drain", async () => {
    const { queue, hub } = rigQueue();
    // a proposal staged by a build that spoke contract v2 (loaded from disk
    // after a downgrade — the stale-contract story)
    const { proposal } = queue.enqueue(modeProposalInput({ contractVersion: 2 }));
    expect(proposal!.contractVersion).toBe(2);

    const report = await queue.drain();
    expect(report.rejected.length).toBe(1);
    expect(report.rejected[0].message).toContain("v2"); // the seen version
    expect(report.rejected[0].message).toContain(`v${FLEET_CONTRACT_VERSION}`); // this consumer's version
    expect(hub.executionCount()).toBe(0); // NEVER executed
    // the proposal stays staged + surfaced with the loud rejection recorded
    const stored = queue.proposals()[0];
    expect(stored.state).toBe("staged");
    expect(stored.rejection).toContain("v2");
    expect(stored.rejection).toContain(`v${FLEET_CONTRACT_VERSION}`);
    // and it never wedges the drain: a later lawful proposal still applies
    const lawful = queue.enqueue(fleetWriteInput());
    const again = await queue.drain();
    expect(again.applied).toEqual([lawful.proposal!.id]);
    expect(hub.executionCount()).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC 10 — F9: the full fixture matrix (spec §8 row F9)
// ══════════════════════════════════════════════════════════════════════════════

describe("#1092 F9 — the full fixture matrix (confirm offline → world changes → reconnect; fetch dies; blocked ahead; double-confirm)", () => {
  it("F9 row 1: confirm offline → the world changes → reconnect re-verify → staged-pending-reconfirm, NEVER applied (n_duplicate_applies == 0)", async () => {
    // OFFLINE: the human confirms; the proposal stages durably (no drain —
    // nothing applies offline)
    const offline = rigQueue();
    const { proposal } = offline.queue.enqueue(modeProposalInput());
    expect(proposal!.state).toBe("staged");
    expect(offline.hub.executionCount()).toBe(0);

    // RECONNECT (the same device, a fresh queue over the same store): the
    // fresh truth no longer matches the confirmed precondition
    const reconnected = newQueue(
      new ModeMachine(),
      new ProposalStore({ path: offline.storePath }),
      offline.hub,
      new FakeClock(),
      () => ({ devices: ["mini"] }), // macbook left the topology while offline
      { maxRetries: 3, retryBaseDelayMs: 100, retryMaxDelayMs: 400 },
    );
    const report = await reconnected.drain();
    expect(report.pendingReconfirm).toEqual([proposal!.id]);
    expect(reconnected.proposals()[0].state).toBe("pending-reconfirm");
    expect(offline.hub.executionCount()).toBe(0); // never applied
    expect(reconnected.stats().n_duplicate_applies).toBe(0);
  });

  it("F9 row 2: the fetch DIES mid-re-verify → blocked-degraded + degraded posture + bounded retry + NO state rename", async () => {
    const { queue, machine, clock } = rigQueue({
      fetchTruth: () => {
        throw new Error("reconnect fetch died mid-re-verify");
      },
      config: { maxRetries: 2, retryBaseDelayMs: 50, retryMaxDelayMs: 50 },
    });
    const { proposal } = queue.enqueue(modeProposalInput());
    const report = await queue.drain();
    expect(report.blockedDegraded).toEqual([proposal!.id]);
    expect(queue.proposals()[0].state).toBe("blocked-degraded");
    expect(queue.proposals()[0].state).not.toBe("pending-reconfirm"); // no rename
    expect(machine.read().posture).toBe("degraded");
    expect(clock.pending()).toBe(50); // the bounded retry, FakeClock-driven
    clock.advance(50); // the retry attempt
    await queue.idle();
    expect(queue.proposals()[0].state).toBe("blocked-degraded"); // still
    expect(clock.pending()).toBeNull(); // the retry budget (2 attempts) is exhausted
  });

  it("F9 row 3: a fetch-blocked proposal AHEAD of a mode proposal — the mode proposal still applies (no wedge)", async () => {
    const { queue, hub } = rigQueue({
      fetchTruth: (p) => {
        if (p.type === "fleet-write") throw new Error("hub fetch died");
        return { devices: ["mini", "macbook"] };
      },
    });
    const blocked = queue.enqueue(fleetWriteInput());
    const mode = queue.enqueue(modeProposalInput());
    const report = await queue.drain();
    expect(report.blockedDegraded).toEqual([blocked.proposal!.id]);
    expect(report.applied).toEqual([mode.proposal!.id]);
    expect(hub.executionCount()).toBe(1);
    expect(hub.applied[0].type).toBe("mode-change");
  });

  it("F9 row 4: double-confirm across two devices → n_duplicate_applies == 0 via the portable request identity", async () => {
    const { deviceA, deviceB, sharedHub } = rigDevicePair();
    const a = deviceA.queue.enqueue(modeProposalInput());
    const b = deviceB.queue.enqueue(modeProposalInput());
    expect(identityKeyOf(a.proposal!.identity)).toBe(identityKeyOf(b.proposal!.identity));

    await deviceA.queue.drain();
    await deviceB.queue.drain();

    expect(sharedHub.executionCount()).toBe(1); // ONE execution across both
    expect(sharedHub.nDuplicateApplies()).toBe(0); // n_duplicate_applies == 0
    expect(deviceA.queue.stats().n_duplicate_applies).toBe(0);
    expect(deviceB.queue.stats().n_duplicate_applies).toBe(0);
    // both devices rest applied with the SAME result
    expect(deviceA.queue.receipts()[0].result).toEqual(deviceB.queue.receipts()[0].result);
  });
});

// #1072 (fleet rearchitect P4a-2, ADR-0005 — the vocabulary law): the
// two-phase mode-transition engine GROWN ON the #1069 ModeMachine surface:
// stage → verify → commit, journalled + rollback-able (spec-20260913-114814
// §2.2 row 2, invariant 1 as amended, §8 F2).
//
// The mechanics, asserted through the F-harness (#1049/#1051):
//   · STAGE takes the pre-stage snapshot of MODE-SCOPED local state BEFORE
//     any state writes — the snapshot pins the last human-confirmed mode
//     config; staging itself writes NO attach-state field.
//   · VERIFY is an injectable attach test bounded by an injectable budget
//     (the #1034 60s patience is the FLOOR). TRANSIENT fail → return to
//     staged with the snapshot retained; re-verify needs NO fresh confirm
//     (the human confirmed the proposal, not the timing). STRUCTURAL fail →
//     AUTOMATIC rollback to the pre-stage snapshot (restoration, not
//     mutation: local-only, idempotent, hub-side untouched).
//   · COMMIT is the ONLY mode writer, atomic + journalled, with the
//     KillHookRegistry's named boundaries: a kill at "pre-commit" leaves
//     nothing written; a kill at "mid-commit" leaves the journaled
//     commit-pending state — the journal record restores or resumes, never
//     half-applies. commit-pending renders as a labeled badge (the snapshot
//     live), persisted in the MODE journal — NEVER in the posture field
//     (invariant 7; the posture vocabulary stays closed).
//   · The commit-pending wall-clock cap surfaces a staged abort/resume
//     choice confirmable locally + a local force-resolve verb — FakeClock
//     driven, zero wall-clock waits.
//   · F2: n_non_atomic_mode_switches == 0 over the full kill/fail matrix;
//     the mode field is written ONLY by human-confirmed commit paths.
//   · The P4a-3 serialization seam: a verify-entry hook fired BEFORE the
//     attach test — the future proposal queue drains there (D2); no queue
//     implementation exists in this slice.
import { describe, it, expect, afterEach } from "vitest";
import {
  ATTACH_POSTURES,
  ModeMachine,
  ModeTransitionEngine,
  DEFAULT_MODE_TRANSITION_CONFIG,
  VERIFY_BUDGET_FLOOR_MS,
  type AttachMode,
  type AttachStateRecord,
  type VerifyContext,
  type VerifyOutcome,
} from "../src/amicode_service/attach_state";
import {
  KillHookRegistry,
  SimulatedCrash,
} from "./fixtures/fleet_fault_harness/kill_hook";
import { FakeClock } from "./fixtures/fleet_fault_harness/test_clock";
import {
  FaultProxy,
  probeOnce,
  startEchoBackend,
} from "./fixtures/fleet_fault_harness/fault_proxy";

const PROBE_DEADLINE_MS = 150;

const disposers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (disposers.length) {
    const d = disposers.pop();
    await d?.();
  }
});

async function startProxy(mode = "pass") {
  const backend = await startEchoBackend();
  const proxy = new FaultProxy({ targetPort: backend.port });
  await proxy.listen();
  await proxy.setMode(mode as never);
  disposers.push(async () => {
    await proxy.close();
    await backend.close();
  });
  return proxy;
}

/** An attach test that probes the REAL fault proxy and classifies the
 *  outcome: any no-response is a TRANSIENT fail (timing, not a world change);
 *  a response is a pass. */
function proxyVerify(proxy: FaultProxy) {
  return async (): Promise<VerifyOutcome> => {
    const outcome = await probeOnce(proxy.port, PROBE_DEADLINE_MS);
    return outcome.kind === "response"
      ? { kind: "pass" }
      : { kind: "transient-fail", detail: `attach test: ${outcome.kind}` };
  };
}

function rig(opts: {
  initial?: AttachStateRecord;
  mode?: AttachMode;
  verify?: (ctx: VerifyContext) => Promise<VerifyOutcome> | VerifyOutcome;
  config?: Record<string, number>;
  clock?: FakeClock;
  hooks?: KillHookRegistry;
  onVerifyEntry?: (ctx: VerifyContext) => Promise<void> | void;
} = {}) {
  const machine = new ModeMachine(
    opts.initial !== undefined ? { initial: opts.initial } : {},
  );
  if (opts.mode !== undefined) machine.confirmMode(opts.mode, "fixture: prior human confirm");
  const engine = new ModeTransitionEngine({
    machine,
    verify: opts.verify ?? (() => ({ kind: "pass" }) as VerifyOutcome),
    ...(opts.config !== undefined ? { config: opts.config as never } : {}),
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
    ...(opts.onVerifyEntry !== undefined ? { onVerifyEntry: opts.onVerifyEntry } : {}),
  });
  return { machine, engine };
}

/** The F2 counter: a mode value that is neither the pre-stage human-confirmed
 *  mode NOR backed by a completed journaled commit + a human-confirm mode
 *  write is a NON-ATOMIC mode switch. Zero across the whole matrix. */
function nonAtomicModeSwitches(machine: ModeMachine, preStageMode: AttachMode): number {
  const mode = machine.read().mode;
  if (mode === preStageMode) return 0; // not switched — nothing half-applied
  const journal = machine.journal();
  const commit = journal.find((e) => e.kind === "transition-commit" && e.to === mode);
  const confirm = machine
    .writeLog()
    .find((w) => w.field === "mode" && w.writer === "human-confirm" && w.value === mode);
  return commit !== undefined && confirm !== undefined ? 0 : 1;
}

/** The mode-field provenance invariant: every mode-field write in the render
 *  log came from a human-confirmed commit path (rollback restores the
 *  identical confirmed value and therefore never writes mode). */
function modeFieldWritesAllHumanConfirmed(machine: ModeMachine): boolean {
  const modeWrites = machine.writeLog().filter((w) => w.field === "mode");
  return modeWrites.every((w) => w.writer === "human-confirm");
}

// ══════════════════════════════════════════════════════════════════════════════
// STAGE — the pre-stage snapshot, BEFORE any state writes (AC 1)
// ══════════════════════════════════════════════════════════════════════════════

describe("#1072 stage — pre-stage snapshot first, no state writes", () => {
  it("stage snapshots the mode-scoped local state BEFORE any state writes; the snapshot pins the last human-confirmed mode config", () => {
    const { machine, engine } = rig({ mode: "fleet" });
    const recordBefore = machine.read().record;
    const writesBefore = machine.writeLog().length;

    const snapshot = engine.stage({ to: "standalone", reason: "detach: human-confirmed proposal" });

    // the snapshot pins the LAST HUMAN-CONFIRMED mode config (raw fields + resolved)
    expect(snapshot.mode).toBe("fleet");
    expect(snapshot.fields).toEqual({ mode: "fleet", state: "fleet" });
    // stage wrote NO attach-state field: the record, the render log, untouched
    expect(machine.read().record).toEqual(recordBefore);
    expect(machine.writeLog().length).toBe(writesBefore);
    // the stage entry lives in the MODE journal with the snapshot
    const journal = machine.journal();
    const stageEntry = journal[journal.length - 1];
    expect(stageEntry).toMatchObject({
      kind: "transition-stage",
      from: "fleet",
      to: "standalone",
    });
    if (stageEntry.kind === "transition-stage") {
      expect(stageEntry.snapshot).toEqual(snapshot);
    }
    expect(engine.state()).toBe("staged");
  });

  it("apply fields are mode-scoped by construction — the snapshot covers everything commit could write (rollback's write set)", () => {
    const { machine, engine } = rig({
      mode: "standalone",
      initial: { fleet_program: "v1" },
    });
    const snapshot = engine.stage({
      to: "fleet",
      apply: { fleet_program: "v2" },
      modeScopedFields: ["fleet_program"],
    });
    expect(snapshot.fields).toEqual({
      mode: "standalone",
      state: "standalone",
      fleet_program: "v1",
    });
    expect(engine.proposal()).toMatchObject({
      to: "fleet",
      modeScopedFields: ["fleet_program"],
    });
  });

  it("stage without a prior confirm pins the base default (mode absent = standalone)", () => {
    const { engine } = rig();
    const snapshot = engine.stage({ to: "fleet" });
    expect(snapshot.mode).toBe("standalone");
  });

  it("the verbs refuse from wrong states: no second transition in flight, no commit without verify, no verify from idle, no transition to the already-confirmed mode", () => {
    const { engine } = rig({ mode: "standalone" });
    expect(() => engine.verify()).toThrow();
    expect(() => engine.commit()).toThrow();
    engine.stage({ to: "fleet" });
    expect(() => engine.stage({ to: "standalone" })).toThrow(/in flight/);
    expect(() => engine.commit()).toThrow(/verified/);
    const { engine: sameMode } = rig({ mode: "fleet" });
    expect(() => sameMode.stage({ to: "fleet" })).toThrow(/already/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// VERIFY — transient fail (AC 2, the FaultProxy's transient fault modes)
// ══════════════════════════════════════════════════════════════════════════════

describe("#1072 verify — transient fail: staged with the snapshot retained, re-verify without fresh confirm", () => {
  it("every FaultProxy transient mode (drop, half-open, refuse, clean-close) lands a TRANSIENT verify-fail — staged, snapshot retained", async () => {
    for (const mode of ["drop", "half-open", "refuse", "clean-close"] as const) {
      const proxy = await startProxy(mode);
      const { machine, engine } = rig({ mode: "standalone", verify: proxyVerify(proxy) });
      const snapshot = engine.stage({ to: "fleet" });
      const out = await engine.verify();
      expect(out.kind, `${mode} must land transient-fail`).toBe("transient-fail");
      expect(engine.state()).toBe("staged"); // return to staged — the snapshot retained
      expect(engine.snapshot()).toEqual(snapshot);
      expect(machine.read().mode).toBe("standalone"); // nothing was written
      const verifyEntries = machine.journal().filter((e) => e.kind === "transition-verify");
      expect(verifyEntries.length).toBe(1);
      expect(verifyEntries[0]).toMatchObject({ outcome: "transient-fail" });
    }
  });

  it("re-verify after a transient fail needs NO fresh confirm — the human confirmed the proposal, not the timing (the full path through the real proxy)", async () => {
    const proxy = await startProxy("drop");
    const { machine, engine } = rig({ mode: "standalone", verify: proxyVerify(proxy) });
    engine.stage({ to: "fleet", reason: "enroll: human-confirmed proposal" });
    const humanConfirmsBefore = machine.journal().filter((e) => e.kind === "human-confirm").length;

    const fail = await engine.verify();
    expect(fail.kind).toBe("transient-fail");
    expect(machine.journal().filter((e) => e.kind === "human-confirm").length)
      .toBe(humanConfirmsBefore); // the fail minted NO fresh confirm

    // the tunnel heals — re-verify, still no fresh confirm, then commit
    await proxy.setMode("pass");
    const pass = await engine.verify();
    expect(pass.kind).toBe("pass");
    expect(machine.journal().filter((e) => e.kind === "human-confirm").length)
      .toBe(humanConfirmsBefore); // the re-verify minted NO fresh confirm either
    expect(engine.state()).toBe("verified");

    engine.commit();
    expect(machine.read().mode).toBe("fleet");
    // the ONLY fresh human-confirm in the journal is the commit's own write
    expect(machine.journal().filter((e) => e.kind === "human-confirm").length)
      .toBe(humanConfirmsBefore + 1);
    // the full journaled sequence: confirm, stage, verify-fail, verify-pass, commit-pending, confirm, commit
    expect(machine.journal().map((e) => e.kind)).toEqual([
      "human-confirm",
      "transition-stage",
      "transition-verify",
      "transition-verify",
      "transition-commit-pending",
      "human-confirm",
      "transition-commit",
    ]);
  });

  it("the verify budget expiring is a TRANSIENT fail (timing, not a world change) — FakeClock-driven, zero wall-clock waits", async () => {
    const clock = new FakeClock();
    let impl: (ctx: VerifyContext) => Promise<VerifyOutcome> = () =>
      new Promise(() => {}); // an attach test that never settles
    const { machine, engine } = rig({
      mode: "standalone",
      clock,
      verify: (ctx) => impl(ctx),
    });
    const snapshot = engine.stage({ to: "fleet" });

    const pending = engine.verify(); // NOT awaited before the advance — the clock drives the deadline
    clock.advance(VERIFY_BUDGET_FLOOR_MS);
    const out = await pending;
    expect(out.kind).toBe("transient-fail");
    if (out.kind === "transient-fail") expect(out.detail).toContain("budget");
    expect(engine.state()).toBe("staged");
    expect(engine.snapshot()).toEqual(snapshot); // retained

    // the attach test then settles — re-verify works, no fresh confirm
    impl = () => ({ kind: "pass" });
    const pass = await engine.verify();
    expect(pass.kind).toBe("pass");
    expect(engine.state()).toBe("verified");
    expect(machine.read().mode).toBe("standalone"); // still nothing written
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// VERIFY — structural fail: AUTOMATIC rollback (AC 3)
// ══════════════════════════════════════════════════════════════════════════════

describe("#1072 verify — structural fail: automatic rollback, local-only, idempotent, hub-side untouched", () => {
  const structural: VerifyOutcome = {
    kind: "structural-fail",
    detail: "mode changed elsewhere: the fresh projection no longer lists this device",
  };

  it("structural fail rolls back to the pre-stage snapshot automatically: mode-scoped fields restored, hub-side state untouched", async () => {
    const { machine, engine } = rig({
      mode: "standalone",
      initial: { fleet_program: "v1", hub_proposal_receipt: "hub-apply-42" },
      verify: () => structural,
    });
    engine.stage({ to: "fleet", modeScopedFields: ["fleet_program"] });
    // mid-transition local drift + a hub-side apply landing (NOT mode-scoped)
    machine.overlayRewrite({ fleet_program: "drift-v9", hub_proposal_receipt: "hub-apply-99" });

    const out = await engine.verify();
    expect(out.kind).toBe("structural-fail");
    expect(engine.state()).toBe("rolled-back");

    const read = machine.read();
    expect(read.mode).toBe("standalone"); // the last human-confirmed mode — restored
    expect(read.record.fleet_program).toBe("v1"); // mode-scoped: restored
    expect(read.record.hub_proposal_receipt).toBe("hub-apply-99"); // hub-side: UNTOUCHED
    // the journal records the automatic rollback (invariant 1's sole automatic action)
    const rollbackEntries = machine.journal().filter((e) => e.kind === "transition-rollback");
    expect(rollbackEntries.length).toBe(1);
    expect(rollbackEntries[0]).toMatchObject({ restored: "standalone" });
    // restoration of the identical confirmed mode is a NO-OP on the mode
    // field: the only mode writes in the render log are human-confirms
    expect(modeFieldWritesAllHumanConfirmed(machine)).toBe(true);
  });

  it("rollback is idempotent — a second rollback is a no-op", async () => {
    const { machine, engine } = rig({
      mode: "standalone",
      initial: { fleet_program: "v1" },
      verify: () => structural,
    });
    engine.stage({ to: "fleet", modeScopedFields: ["fleet_program"] });
    machine.overlayRewrite({ fleet_program: "drift-v9" });
    await engine.verify(); // automatic rollback

    const recordAfterFirst = machine.read().record;
    const journalAfterFirst = machine.journal().length;

    const second = engine.rollback("double rollback");
    expect(second).toEqual({ rolledBack: false, restoredFields: [] });
    expect(machine.read().record).toEqual(recordAfterFirst); // nothing re-written
    expect(machine.journal().length).toBe(journalAfterFirst); // no second rollback entry
  });

  it("the machine's restore path refuses posture — transport-owned render-only state is never mode-scoped", () => {
    const machine = new ModeMachine({ initial: { mode: "fleet", posture: "degraded" } });
    expect(() => machine.restoreModeScoped({ posture: "ok" })).toThrow(/posture/);
  });

  it("the machine's restore path CAN restore a diverged mode config (the machinery, proven at the machine level)", () => {
    const machine = new ModeMachine({ initial: { mode: "fleet", state: "fleet" } });
    const { restored } = machine.restoreModeScoped({ mode: "standalone", state: "standalone" });
    expect(restored).toContain("mode");
    expect(machine.read().mode).toBe("standalone");
    expect(machine.read().record.state).toBe("standalone");
    // and restoring the identical config again is a no-op (idempotent)
    const again = machine.restoreModeScoped({ mode: "standalone", state: "standalone" });
    expect(again.restored).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// COMMIT — the kill matrix, journaled commit-pending, never torn (AC 4)
// ══════════════════════════════════════════════════════════════════════════════

describe("#1072 commit — the KillHookRegistry matrix: pre-commit / mid-commit, stop / throw / crash", () => {
  it("kill at pre-commit (stop): halted at verified — NOTHING written, no journal record; resume completes the commit", async () => {
    const hooks = new KillHookRegistry();
    hooks.arm("pre-commit", { kind: "stop" });
    const { machine, engine } = rig({ mode: "standalone", hooks });
    engine.stage({ to: "fleet", apply: { fleet_program: "v2" }, modeScopedFields: ["fleet_program"] });
    await engine.verify();
    const recordBefore = machine.read().record;

    engine.commit();
    expect(engine.state()).toBe("verified"); // still pre-commit
    expect(engine.haltedAt()).toBe("pre-commit");
    expect(machine.read().record).toEqual(recordBefore); // nothing applied
    expect(machine.journal().filter((e) => e.kind === "transition-commit-pending").length).toBe(0);

    hooks.disarm("pre-commit");
    engine.resume(); // the proposal was human-confirmed — no fresh confirm needed
    expect(engine.state()).toBe("committed");
    expect(machine.read().mode).toBe("fleet");
    expect(machine.read().record.fleet_program).toBe("v2");
    expect(machine.journal().filter((e) => e.kind === "transition-commit").length).toBe(1);
  });

  it("kill at pre-commit (crash): the SimulatedCrash escapes — nothing written, no journal record; the transition resumes cleanly", async () => {
    const hooks = new KillHookRegistry();
    hooks.arm("pre-commit", { kind: "crash" });
    const { machine, engine } = rig({ mode: "standalone", hooks });
    engine.stage({ to: "fleet" });
    await engine.verify();
    const recordBefore = machine.read().record;

    expect(() => engine.commit()).toThrow(SimulatedCrash);
    expect(engine.state()).toBe("verified"); // pre-commit: the crash escaped before anything was written
    expect(machine.read().record).toEqual(recordBefore);
    expect(machine.journal().filter((e) => e.kind === "transition-commit-pending").length).toBe(0);

    hooks.disarm("pre-commit");
    engine.resume();
    expect(machine.read().mode).toBe("fleet");
  });

  it("kill at mid-commit (stop): journaled commit-pending, NEVER torn — nothing applied, the badge renders the snapshot live, and the posture field never carries it (invariant 7)", async () => {
    const hooks = new KillHookRegistry();
    hooks.arm("mid-commit", { kind: "stop" });
    const clock = new FakeClock();
    const { machine, engine } = rig({ mode: "standalone", hooks, clock });
    engine.stage({
      to: "fleet",
      apply: { fleet_program: "v2" },
      modeScopedFields: ["fleet_program"],
    });
    await engine.verify();
    const recordBefore = machine.read().record;

    engine.commit();
    expect(engine.state()).toBe("commit-pending");
    expect(engine.haltedAt()).toBe("mid-commit");
    expect(machine.read().record).toEqual(recordBefore); // NEVER torn: nothing half-applied

    // the journal record: commit-pending persisted in the MODE journal
    const pendingEntries = machine.journal().filter((e) => e.kind === "transition-commit-pending");
    expect(pendingEntries.length).toBe(1);
    expect(pendingEntries[0]).toMatchObject({ to: "fleet" });

    // the labeled badge renders the pre-stage snapshot live
    const view = engine.pending();
    expect(view).not.toBeNull();
    expect(view!.badge).toContain("commit-pending");
    expect(view!.badge).toContain("standalone"); // the last human-confirmed mode, rendered live
    expect(view!.snapshot.mode).toBe("standalone");
    expect(view!.capElapsed).toBe(false); // the cap has not elapsed
    expect(view!.choices).toBeNull(); // the abort/resume choice is not surfaced yet

    // invariant 7: commit-pending is a MODE-JOURNAL state — the posture field
    // NEVER carries it (the vocabulary stays closed)
    expect(machine.read().record.posture).not.toBe("commit-pending");
    expect(ATTACH_POSTURES).not.toContain("commit-pending");
    expect(ATTACH_POSTURES).toContain(machine.read().posture);

    hooks.disarm("mid-commit");
    engine.resume(); // the journal record RESUMES — replay to committed
    expect(engine.state()).toBe("committed");
    expect(machine.read().mode).toBe("fleet");
    expect(machine.read().record.fleet_program).toBe("v2");
    expect(engine.pending()).toBeNull(); // resolved — no dangling pending
  });

  it("kill at mid-commit (crash): the journal record restores or resumes — a FRESH engine recovers from the journal and force-resolves", async () => {
    const hooks = new KillHookRegistry();
    hooks.arm("mid-commit", { kind: "crash" });
    const { machine, engine } = rig({ mode: "standalone", hooks });
    engine.stage({
      to: "fleet",
      apply: { fleet_program: "v2" },
      modeScopedFields: ["fleet_program"],
    });
    await engine.verify();
    const recordBefore = machine.read().record;

    expect(() => engine.commit()).toThrow(SimulatedCrash);
    expect(machine.read().record).toEqual(recordBefore); // never torn
    expect(machine.journal().filter((e) => e.kind === "transition-commit-pending").length).toBe(1);

    // process-death story: a FRESH engine on the same machine recovers the
    // pending transition from the MODE journal
    const engine2 = new ModeTransitionEngine({ machine, verify: () => ({ kind: "pass" }) });
    expect(engine2.state()).toBe("commit-pending");
    const view = engine2.pending();
    expect(view).not.toBeNull();
    expect(view!.snapshot.mode).toBe("standalone");
    expect(view!.badge).toContain("commit-pending");

    engine2.forceResolvePending("resume"); // the local force-resolve verb
    expect(machine.read().mode).toBe("fleet");
    expect(machine.read().record.fleet_program).toBe("v2");
    const resolves = machine.journal().filter((e) => e.kind === "transition-resolve");
    expect(resolves.length).toBe(1);
    expect(resolves[0]).toMatchObject({ action: "resume", via: "force" });
    expect(engine2.state()).toBe("committed");
  });

  it("resume is idempotent once committed — a second resume refuses, the pending view is gone", async () => {
    const hooks = new KillHookRegistry();
    hooks.arm("mid-commit", { kind: "stop" });
    const { machine, engine } = rig({ mode: "standalone", hooks });
    engine.stage({ to: "fleet" });
    await engine.verify();
    engine.commit(); // halted mid-commit
    hooks.disarm("mid-commit");
    engine.resume();
    expect(engine.state()).toBe("committed");
    expect(() => engine.resume()).toThrow();
    expect(() => engine.forceResolvePending("resume")).toThrow(/no commit-pending/);
    expect(engine.pending()).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The commit-pending wall-clock cap + the local force-resolve verb (AC 5)
// ══════════════════════════════════════════════════════════════════════════════

describe("#1072 the commit-pending wall-clock cap — FakeClock-driven, zero wall-clock waits", () => {
  function haltedPending(capMs: number) {
    const hooks = new KillHookRegistry();
    hooks.arm("mid-commit", { kind: "stop" });
    const clock = new FakeClock();
    const r = rig({
      mode: "standalone",
      hooks,
      clock,
      config: { pendingCapMs: capMs },
      initial: { fleet_program: "v1" },
    });
    r.engine.stage({ to: "fleet", apply: { fleet_program: "v2" }, modeScopedFields: ["fleet_program"] });
    return { ...r, hooks, clock };
  }

  it("before the cap the choice is NOT surfaced and resolvePending refuses — but the local force-resolve verb works", async () => {
    const { machine, engine, hooks, clock } = haltedPending(30_000);
    void clock;
    await engine.verify();
    engine.commit(); // halted mid-commit: commit-pending

    expect(engine.pending()!.capElapsed).toBe(false);
    expect(() => engine.resolvePending("abort")).toThrow(/cap/);

    engine.forceResolvePending("abort"); // the local verb — no cap, no hub
    expect(engine.state()).toBe("rolled-back");
    expect(machine.read().mode).toBe("standalone"); // restored to the pre-stage snapshot
    expect(machine.read().record.fleet_program).toBe("v1");
    expect(machine.journal().filter((e) => e.kind === "transition-resolve"))
      .toMatchObject([{ action: "abort", via: "force" }]);
    expect(hooks.fired).toEqual([{ point: "mid-commit", kind: "stop" }]);
  });

  it("the cap surfacing the staged abort/resume choice, confirmable locally: RESUME completes the commit", async () => {
    const { machine, engine, clock } = haltedPending(30_000);
    await engine.verify();
    engine.commit(); // halted mid-commit

    clock.advance(30_000); // the wall-clock cap elapses — zero wall-clock waits
    const view = engine.pending()!;
    expect(view.capElapsed).toBe(true);
    expect(view.choices).toEqual(["abort", "resume"]);

    engine.resolvePending("resume");
    expect(engine.state()).toBe("committed");
    expect(machine.read().mode).toBe("fleet");
    expect(machine.journal().filter((e) => e.kind === "transition-resolve"))
      .toMatchObject([{ action: "resume", via: "cap-choice" }]);
  });

  it("the cap surfacing the staged abort/resume choice, confirmable locally: ABORT rolls back to the pre-stage snapshot", async () => {
    const { machine, engine, clock } = haltedPending(30_000);
    await engine.verify();
    engine.commit(); // halted mid-commit

    clock.advance(30_001);
    expect(engine.pending()!.capElapsed).toBe(true);

    engine.resolvePending("abort");
    expect(engine.state()).toBe("rolled-back");
    expect(machine.read().mode).toBe("standalone");
    expect(machine.read().record.fleet_program).toBe("v1"); // the snapshot restored
    const kinds = machine.journal().map((e) => e.kind);
    expect(kinds).toContain("transition-resolve");
    expect(kinds).toContain("transition-rollback");
    // the posture field never carried any of it (invariant 7)
    expect(machine.read().record.posture).not.toBe("commit-pending");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// F2 — the full kill/fail matrix: n_non_atomic_mode_switches == 0 (AC 6/7)
// ══════════════════════════════════════════════════════════════════════════════

describe("#1072 F2 — n_non_atomic_mode_switches == 0 over the full kill/fail matrix", () => {
  const PRE_STAGE: AttachMode = "standalone";

  async function runScenario(kind: string): Promise<ModeMachine> {
    if (kind === "transient-fail") {
      const proxy = await startProxy("drop");
      const { machine, engine } = rig({ mode: PRE_STAGE, verify: proxyVerify(proxy) });
      engine.stage({ to: "fleet" });
      await engine.verify(); // transient fail — staged with the snapshot retained
      return machine;
    }
    if (kind === "structural-fail") {
      const { machine, engine } = rig({
        mode: PRE_STAGE,
        verify: () => ({ kind: "structural-fail", detail: "mode changed elsewhere" }),
      });
      engine.stage({ to: "fleet" });
      await engine.verify(); // automatic rollback
      return machine;
    }
    // the kill scenarios: pre-commit and mid-commit, stop/throw/crash
    const [point, fault] = kind.split(":") as ["pre-commit" | "mid-commit", "stop" | "throw" | "crash"];
    const hooks = new KillHookRegistry();
    hooks.arm(point, { kind: fault, ...(fault === "throw" ? { error: new Error("injected") } : {}) });
    const { machine, engine } = rig({ mode: PRE_STAGE, hooks });
    engine.stage({ to: "fleet" });
    await engine.verify();
    try {
      engine.commit();
    } catch {
      // throw/crash escape — the machine keeps whatever was journaled
    }
    return machine;
  }

  it("every scenario in the matrix ends honest: mode either unswitched or atomically committed-and-journaled", async () => {
    const matrix = [
      "pre-commit:stop",
      "pre-commit:throw",
      "pre-commit:crash",
      "mid-commit:stop",
      "mid-commit:throw",
      "mid-commit:crash",
      "transient-fail",
      "structural-fail",
    ];
    let nonAtomic = 0;
    for (const kind of matrix) {
      const machine = await runScenario(kind);
      const violations = nonAtomicModeSwitches(machine, PRE_STAGE);
      expect(violations, `${kind} must end honest`).toBe(0);
      nonAtomic += violations;
      // the mode field is written ONLY by human-confirmed commit paths
      expect(modeFieldWritesAllHumanConfirmed(machine), `${kind}: mode writes all human-confirm`).toBe(true);
      // no transport write ever named mode (the #1069 floor holds under the engine too)
      expect(machine.transportModeWriteCount()).toBe(0);
      // invariant 7: the posture field never carries commit-pending; the vocabulary stays closed
      expect(machine.read().record.posture).not.toBe("commit-pending");
      expect(ATTACH_POSTURES).toContain(machine.read().posture);
      // never torn: a journaled commit-pending without a completed commit left NOTHING applied
      const pending = machine.journal().filter((e) => e.kind === "transition-commit-pending").length;
      const committed = machine.journal().filter((e) => e.kind === "transition-commit").length;
      if (committed === 0 && pending > 0) {
        expect(machine.read().mode, `${kind}: journaled-pending but uncommitted means NOTHING applied`).toBe(PRE_STAGE);
      }
    }
    expect(nonAtomic).toBe(0); // n_non_atomic_mode_switches == 0
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The serialization seam (P4a-3, D2) — the verify-entry hook (AC 8)
// ══════════════════════════════════════════════════════════════════════════════

describe("#1072 the verify-entry seam — the future proposal queue's drain point, no queue yet", () => {
  it("the onVerifyEntry hook fires BEFORE the attach test, once per verify attempt — the D2 drain point (queue drains before verify)", async () => {
    const order: string[] = [];
    const seen: VerifyContext[] = [];
    let impl: (ctx: VerifyContext) => Promise<VerifyOutcome> | VerifyOutcome = () => {
      order.push("attach-test");
      return { kind: "pass" };
    };
    const { engine } = rig({
      mode: "standalone",
      verify: (ctx) => impl(ctx),
      onVerifyEntry: (ctx) => {
        order.push("drain");
        seen.push(ctx);
      },
    });
    engine.stage({ to: "fleet" });
    await engine.verify();
    expect(order).toEqual(["drain", "attach-test"]); // BEFORE the attach test

    // a transient fail then a re-verify: the seam fires again per attempt
    impl = () => {
      order.push("attach-test");
      return { kind: "transient-fail", detail: "timeout" };
    };
    await engine.verify();
    await engine.verify();
    expect(order).toEqual(["drain", "attach-test", "drain", "attach-test", "drain", "attach-test"]);

    // the seam receives the transition + the clamped budget (the P4b program composes it)
    expect(seen[0].transition.from).toBe("standalone");
    expect(seen[0].transition.to).toBe("fleet");
    expect(typeof seen[0].transition.id).toBe("string");
    expect(seen[0].budgetMs).toBe(VERIFY_BUDGET_FLOOR_MS);
  });

  it("a throwing drain hook leaves the transition STAGED — nothing written, nothing journaled for the attempt", async () => {
    const { machine, engine } = rig({
      mode: "standalone",
      verify: () => ({ kind: "pass" }),
      onVerifyEntry: () => {
        throw new Error("queue drain failed");
      },
    });
    engine.stage({ to: "fleet" });
    const journalBefore = machine.journal().length;
    await expect(engine.verify()).rejects.toThrow("queue drain failed");
    expect(engine.state()).toBe("staged"); // still staged — re-verify when the drain heals
    expect(machine.journal().length).toBe(journalBefore); // no verify entry journaled
    expect(machine.read().mode).toBe("standalone");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Budgets + thresholds — injectable, base defaults ship (AC 9)
// ══════════════════════════════════════════════════════════════════════════════

describe("#1072 budgets — injectable, the 60s floor, base defaults ship", () => {
  it("the base defaults: the #1034 60s verify floor + a commit-pending wall-clock cap", () => {
    expect(VERIFY_BUDGET_FLOOR_MS).toBe(60_000);
    expect(DEFAULT_MODE_TRANSITION_CONFIG).toEqual({ verifyBudgetMs: 60_000, pendingCapMs: 300_000 });
    const { engine } = rig();
    expect(engine.config()).toEqual(DEFAULT_MODE_TRANSITION_CONFIG);
  });

  it("the verify budget is injectable ABOVE the floor and CLAMPED to the floor below it", () => {
    expect(rig({ config: { verifyBudgetMs: 90_000 } }).engine.config().verifyBudgetMs).toBe(90_000);
    expect(rig({ config: { verifyBudgetMs: 1_000 } }).engine.config().verifyBudgetMs).toBe(60_000);
  });

  it("the pending cap is injectable (the P4b fleet program composes it) — and the seam's budget reflects the clamp", async () => {
    expect(rig({ config: { pendingCapMs: 5_000 } }).engine.config().pendingCapMs).toBe(5_000);
    const seen: number[] = [];
    const { engine } = rig({
      config: { verifyBudgetMs: 500 },
      onVerifyEntry: (ctx) => {
        seen.push(ctx.budgetMs);
      },
    });
    engine.stage({ to: "fleet" });
    await engine.verify();
    expect(seen).toEqual([60_000]); // clamped UP to the floor — never below the #1034 patience
  });
});

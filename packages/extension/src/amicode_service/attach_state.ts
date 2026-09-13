// ATTACH STATE (#1069 — fleet rearchitect P4a-1; the vocabulary law is
// amicissimo ADR-0005, amending the frozen attach-state vocabulary of
// ADR-0004 / substrate D6): the base-owned attach-state schema with mode and
// posture as SEPARATE additive optional fields, and the ModeMachine as the
// SOLE attach-state writer.
//
//   Mode     (standalone | fleet) — human-confirmed fleet membership. Only a
//            human confirm mutates it. Absent = standalone (the base
//            default). NO transport-derived outcome ever writes it.
//   Posture  (ok | degraded | hub-down) — transport-derived rendering.
//            Written only by the transport classifier, through the mode
//            machine. Absent = ok (the base default). `hub-down` is base
//            standalone + a surfaced POINTER — a rendering, never a
//            membership change.
//
// The frozen legacy vocabulary (`state`: fleet | standalone | degraded) is
// PRESERVED, never renamed or removed: the legacy field is dual-written with
// its legacy projection (legacyStateOf) so old readers keep seeing the
// truth they understand, and the read side (resolveAttachState) prefers the
// new fields with a mapping for old values (rearchitect spec §0.2's table):
//
//   frozen state "fleet"      → mode fleet  + posture ok
//   frozen state "degraded"   → mode fleet  + posture degraded
//   frozen state "standalone" → posture hub-down (the transport-written
//                                hub-down entry; its frozen rendering was
//                                base standalone. A frozen standalone cannot
//                                carry the membership fact — that loss is
//                                exactly what the split fixes.)
//
// `commit-pending` is NOT a posture value: it is a mode-machine JOURNAL state
// (P4a-2's two-phase engine) rendered as a labeled badge and persisted in
// the MODE journal. The posture vocabulary is closed at {ok, degraded,
// hub-down}.
//
// THE RENDER-ONLY EXEMPTION (row 3, rearchitect spec §2.2): posture writes
// are render-only and exempt from the D2 serialization rule and the mode
// journal — the badge stays live exactly while the mode machine is stuck.
// This module therefore keeps TWO distinct logs (the D2 serialization rule
// itself is P4a-3's queue; this slice ships only the verify-entry seam it
// will drain through):
//   · writeLog() — an in-memory render record (who wrote what, when) for
//     surfacing and the F3 fixture; NOT a journal, never persisted, exempt.
//   · journal() — the MODE journal surface where the P4a-2 engine (#1072)
//     persists stage/verify/commit states and commit-pending, alongside
//     human confirms. Posture writes NEVER land in it.
//
// Preserve-on-rewrite (the substrate's bidirectional invariant, carried
// across the split unchanged): a base rewrite preserves overlay-written
// fields it does not understand, and an overlay rewrite preserves
// base-written fields — never clobbers in either direction.
//
// The TWO-PHASE TRANSITION ENGINE (P4a-2, #1072) grows at the bottom of
// this module: stage → verify → commit over the ModeMachine, journalled +
// rollback-able. The proposal QUEUE is P4a-3 (this module ships only the
// verify-entry seam it will drain through).
import { randomUUID } from "node:crypto";

export type AttachMode = "standalone" | "fleet";
export type AttachPosture = "ok" | "degraded" | "hub-down";
export type LegacyFleetPostureState = "fleet" | "degraded" | "standalone";

/** The closed vocabularies (asserted in tests; commit-pending is not here). */
export const ATTACH_MODES: readonly AttachMode[] = ["standalone", "fleet"];
export const ATTACH_POSTURES: readonly AttachPosture[] = ["ok", "degraded", "hub-down"];

/** The base-owned attach-state record. mode + posture are ADR-0005's
 *  additive optional fields; `state` is the preserved frozen field; every
 *  other key is overlay-written richer data that base rewrites preserve. */
export interface AttachStateRecord {
  /** Human-confirmed membership. Absent = standalone. */
  mode?: AttachMode;
  /** Transport-derived rendering. Absent = ok. */
  posture?: AttachPosture;
  /** The FROZEN legacy field — dual-written with the legacy projection of
   *  mode + posture so pre-split readers stay truthful. */
  state?: LegacyFleetPostureState;
  /** Overlay-written richer fields survive base rewrites (additive-optional,
   *  open record — preserve-on-rewrite is the invariant). */
  [field: string]: unknown;
}

/** The resolved read: new fields preferred, old values mapped, base
 *  defaults for absence. */
export interface ResolvedAttachState {
  mode: AttachMode;
  posture: AttachPosture;
}

const MODES = new Set<string>(ATTACH_MODES);
const POSTURES = new Set<string>(ATTACH_POSTURES);

/** The read-side mapping (ADR-0005's re-mapping of the frozen values).
 *  Tolerant: a value outside the closed vocabulary reads as absent (the
 *  fail-safe default), never a throw. */
export function resolveAttachState(record: AttachStateRecord): ResolvedAttachState {
  const mode: AttachMode =
    typeof record.mode === "string" && MODES.has(record.mode)
      ? record.mode
      : record.state === "fleet" || record.state === "degraded"
        ? "fleet" // the frozen fleet|degraded were fleet-enrolled renderings
        : "standalone"; // absent (or frozen standalone) = the base default
  const posture: AttachPosture =
    typeof record.posture === "string" && POSTURES.has(record.posture)
      ? record.posture
      : record.state === "degraded"
        ? "degraded"
        : record.state === "standalone"
          ? "hub-down" // the frozen transport-written hub-down entry
          : "ok"; // absent (or frozen fleet) = the base default
  return { mode, posture };
}

/** The legacy projection (new → old): what pre-split readers see. hub-down's
 *  frozen rendering IS base standalone — a rendering, never a membership
 *  change. */
export function legacyStateOf(mode: AttachMode, posture: AttachPosture): LegacyFleetPostureState {
  if (mode === "standalone") return "standalone";
  return posture === "ok" ? "fleet" : posture === "degraded" ? "degraded" : "standalone";
}

/** Bidirectional preserve-on-rewrite: the result carries every field of
 *  `record` except those `patch` itself names. Writers pass ONLY the fields
 *  they own — a base rewrite preserves overlay-written fields it does not
 *  understand, and an overlay rewrite preserves base-written fields. */
export function mergeAttachState(
  record: AttachStateRecord,
  patch: Record<string, unknown>,
): AttachStateRecord {
  return { ...record, ...patch };
}

// ── the structural event surface (row 3; consumed by P4a-3) ──────────────────
//
// Structural-class signals (auth revoked, mode changed elsewhere,
// presumed-structural escalation) surface as TYPED EVENTS for the future
// proposal queue. NO behavior beyond emission: emitting never writes an
// attach-state field, never degrades a posture, never queues an apply.

/** The named structural classes of the row-3 taxonomy. */
export type StructuralSignalClass = "auth-revoked" | "mode-changed-elsewhere" | "presumed-structural";

/** One typed structural signal — the shape the P4a-3 queue will consume. */
export interface StructuralSignal {
  kind: "structural";
  class: StructuralSignalClass;
  detail?: string;
  at: string;
}

/** What emitters pass in; the machine stamps kind + at. */
export type StructuralSignalInput = Omit<StructuralSignal, "kind" | "at"> & { kind?: "structural" };

// ── the write log (render record) and the mode journal ────────────────────────

/** One attach-state write, as a RENDER record (exempt: never a journal). */
export interface AttachStateWriteEntry {
  writer: "transport" | "human-confirm" | "overlay" | "restore";
  /** The machine-owned field the write named: "posture" | "mode" — or
   *  "overlay-fields" for the overlay data path. */
  field: "posture" | "mode" | "overlay-fields";
  /** The value written (mode/posture writes; null for overlay rewrites). */
  value: string | null;
  at: string;
  reason?: string;
}

/** The pre-stage snapshot (#1072): the MODE-SCOPED local state captured
 *  BEFORE any state writes — mode + the dual-written legacy field + the
 *  proposal's mode-scoped overlay fields, pinning the last human-confirmed
 *  mode config. Rollback restores EXACTLY this (invariant 1, as amended:
 *  local-only restoration, hub-side applies untouched). */
export interface TransitionSnapshot {
  mode: AttachMode;
  fields: Record<string, unknown>;
}

/** The confirmed proposal the engine executes (#1072): what the human
 *  confirmed (the `enrollFleet` propose step precedes; the engine never
 *  mints a confirm of its own — commit executes the confirmed proposal). */
export interface TransitionProposalRecord {
  id: string;
  from: AttachMode;
  to: AttachMode;
  reason?: string;
  /** Mode-scoped overlay fields the commit applies (P4b program values). */
  apply?: Record<string, unknown>;
  modeScopedFields: string[];
}

/** A MODE journal entry. This slice's vocabulary per ADR-0005: human
 *  confirms + the P4a-2 transition lifecycle (stage / verify /
 *  commit-pending / commit / rollback / resolve). commit-pending lives
 *  HERE — a mode-journal state — and never in the posture field
 *  (invariant 7). Posture writes are exempt and never land in the journal. */
export type ModeJournalEntry =
  | { kind: "human-confirm"; mode: AttachMode; at: string; reason?: string }
  | {
      kind: "transition-stage";
      from: AttachMode;
      to: AttachMode;
      snapshot: TransitionSnapshot;
      proposal: TransitionProposalRecord;
      at: string;
      reason?: string;
    }
  | {
      kind: "transition-verify";
      outcome: "pass" | "transient-fail" | "structural-fail";
      detail?: string;
      at: string;
    }
  | {
      kind: "transition-commit-pending";
      to: AttachMode;
      snapshot: TransitionSnapshot;
      proposal: TransitionProposalRecord;
      /** The wall-clock instant the pending state began (cap arithmetic). */
      sinceMs: number;
      at: string;
    }
  | { kind: "transition-commit"; to: AttachMode; at: string }
  | { kind: "transition-rollback"; restored: AttachMode; at: string; reason?: string }
  | {
      kind: "transition-resolve";
      action: "abort" | "resume";
      via: "force" | "cap-choice";
      at: string;
    };

/** The machine-owned fields — overlay rewrites never name them. */
const MACHINE_OWNED_FIELDS = new Set(["mode", "posture", "state"]);

/** The mode machine — the SOLE attach-state writer (ADR-0005 decision 2:
 *  the transport classifier writes ONLY the posture field through it).
 *
 *  One machine per attach-state record. Three write paths, three owners:
 *    · writePosture   — the transport classifier's ONLY path in. Writes the
 *      posture field plus its dual-written legacy projection, and
 *      MECHANICALLY cannot name the mode field.
 *    · confirmMode    — the human-confirm path (P4a-2 grows the two-phase
 *      stage→verify→commit engine on this surface). Writes the mode field
 *      plus its legacy projection, never the posture field.
 *    · overlayRewrite — the staged-overlay data path (P4b program values):
 *      merges the patch while PRESERVING the machine-owned fields, even if
 *      the patch tries to name them.
 */
export class ModeMachine {
  private recordValue: AttachStateRecord;
  private readonly writes: AttachStateWriteEntry[] = [];
  private readonly journalEntries: ModeJournalEntry[] = [];
  private readonly structuralLog: StructuralSignal[] = [];
  private readonly structuralListeners: ((e: StructuralSignal) => void)[] = [];
  private readonly now: () => string;

  constructor(opts: { initial?: AttachStateRecord; now?: () => string } = {}) {
    this.recordValue = opts.initial !== undefined ? { ...opts.initial } : {};
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** The transport classifier's write path. ONLY the posture field (plus
   *  the dual-written legacy projection) — the 09-13 accidental-mode-exit
   *  class is structurally impossible: this patch cannot name mode. */
  writePosture(posture: AttachPosture, reason: string): void {
    const { mode } = this.resolve();
    this.recordValue = mergeAttachState(this.recordValue, {
      posture,
      state: legacyStateOf(mode, posture),
    });
    this.writes.push({ writer: "transport", field: "posture", value: posture, at: this.now(), reason });
  }

  /** The human-confirm write path — the ONLY mode writer. (P4a-2's two-phase
   *  engine lands on this surface; this slice provides the confirm verb.) */
  confirmMode(mode: AttachMode, reason?: string): void {
    const { posture } = this.resolve();
    this.recordValue = mergeAttachState(this.recordValue, {
      mode,
      state: legacyStateOf(mode, posture),
    });
    const at = this.now();
    this.writes.push({ writer: "human-confirm", field: "mode", value: mode, at, ...(reason !== undefined ? { reason } : {}) });
    this.journalEntries.push({ kind: "human-confirm", mode, at, ...(reason !== undefined ? { reason } : {}) });
  }

  /** The overlay data rewrite (P4b program values): merges the patch's
   * fields while preserving the machine-owned mode/posture/state — never
   * clobbers in either direction. */
  overlayRewrite(patch: Record<string, unknown>): void {
    const dataOnly: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (MACHINE_OWNED_FIELDS.has(k)) continue;
      dataOnly[k] = v;
    }
    this.recordValue = mergeAttachState(this.recordValue, dataOnly);
    this.writes.push({ writer: "overlay", field: "overlay-fields", value: null, at: this.now() });
  }

  /** The RESTORE path (#1072): invariant 1's rollback exemption — the
   *  machine's only automatic write, and it RESTORES, never advances. Each
   *  named mode-scoped field goes back to its snapshotted value; identical
   *  values are no-ops (idempotent — a double rollback writes nothing).
   *  Posture is REFUSED: transport-owned render state is never mode-scoped.
   *  Restoring mode keeps the legacy dual-write honest (the frozen `state`
   *  projection follows the restored mode when the patch does not name it). */
  restoreModeScoped(fields: Record<string, unknown>): { restored: string[] } {
    if ("posture" in fields) {
      throw new Error(
        "restoreModeScoped: posture is transport-owned render state and is never mode-scoped (ADR-0005)",
      );
    }
    const restored: string[] = [];
    const at = this.now();
    for (const [field, value] of Object.entries(fields)) {
      if (field === "mode") {
        // compare the RESOLVED mode: an absent field with the same semantic
        // value is already-restored — restoration materializes nothing
        if (this.resolve().mode === value) continue;
      } else if (this.recordValue[field] === value) {
        continue; // idempotent: identical value = no write
      }
      const patch: Record<string, unknown> = { [field]: value };
      if (field === "mode") {
        // the legacy dual-write follows the restored mode
        patch.state = legacyStateOf(value as AttachMode, this.resolve().posture);
      }
      this.recordValue = mergeAttachState(this.recordValue, patch);
      restored.push(field);
      this.writes.push({
        writer: "restore",
        field: field === "mode" ? "mode" : "overlay-fields",
        value: field === "mode" ? String(value) : null,
        at,
        reason: "restoreModeScoped: invariant 1's rollback exemption (restores, never advances)",
      });
    }
    return { restored };
  }

  /** The resolved read (new fields preferred, old mapped, defaults). */
  resolve(): ResolvedAttachState {
    return resolveAttachState(this.recordValue);
  }

  /** The full read: resolved mode + posture, the raw record (overlay fields
   *  included), and the hub-down pointer when it applies. */
  read(): ResolvedAttachState & {
    record: AttachStateRecord;
    /** The honest UI-consumable pointer for the hub-down posture: base
     *  standalone running, fleet data honestly unavailable — a rendering,
     *  never a membership change. */
    pointer: string | null;
  } {
    const resolved = this.resolve();
    return {
      ...resolved,
      record: { ...this.recordValue },
      pointer:
        resolved.posture === "hub-down"
          ? "hub-down: the hub is unreachable — the base standalone posture is running; fleet data is honestly unavailable and recoverable"
          : null,
    };
  }

  /** The raw record (for persistence by future slices — none here). */
  record(): AttachStateRecord {
    return { ...this.recordValue };
  }

  /** The render record of every attach-state write. NOT a journal — posture
   *  writes are render-only and exempt from serialization (see the module
   *  header); this log is in-memory surfacing and the F3 fixture's oracle. */
  writeLog(): AttachStateWriteEntry[] {
    return [...this.writes];
  }

  /** The F3 counter: writes by the transport path that named the mode
   *  field. Zero by construction — writePosture cannot name mode. */
  transportModeWriteCount(): number {
    return this.writes.filter((w) => w.writer === "transport" && w.field === "mode").length;
  }

  /** The MODE journal surface (P4a-2's engine persists stage/verify/commit
   *  and commit-pending here). Posture writes NEVER land in it — the
   *  render-only exemption, asserted in tests. */
  journal(): ModeJournalEntry[] {
    return [...this.journalEntries];
  }

  /** The transition engine's journal-append path (#1072): the machine OWNS
   *  the journal; the engine — its only writer besides confirmMode's
   *  human-confirm entry — appends its transition entries through this
   *  seam. Posture writes never arrive here (render-only exemption). */
  appendJournal(entry: ModeJournalEntry): void {
    this.journalEntries.push(entry);
  }

  /** Emit a structural signal: stamp it, log it, notify listeners — and do
   *  NOTHING else. No attach-state write, no posture change, no queue (the
   *  queue is P4a-3). */
  emitStructural(input: StructuralSignalInput): StructuralSignal {
    const signal: StructuralSignal = {
      kind: "structural",
      class: input.class,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      at: this.now(),
    };
    this.structuralLog.push(signal);
    for (const cb of this.structuralListeners) cb(signal);
    return signal;
  }

  /** Subscribe to structural signals (the P4a-3 queue's seam). Returns the
   *  unsubscribe function. */
  onStructural(cb: (e: StructuralSignal) => void): () => void {
    this.structuralListeners.push(cb);
    return () => {
      const i = this.structuralListeners.indexOf(cb);
      if (i !== -1) this.structuralListeners.splice(i, 1);
    };
  }

  /** The structural signals emitted so far (the stub surface's log). */
  structuralEvents(): StructuralSignal[] {
    return [...this.structuralLog];
  }
}

// ── the two-phase mode-transition engine (#1072 — P4a-2) ──────────────────────
//
// GROWN ON the ModeMachine (evolve, never fork): stage → verify → commit,
// journalled + rollback-able (rearchitect spec §2.2 row 2, invariant 1 as
// amended, §8 F2). It executes what a human ALREADY confirmed (the
// `enrollFleet` propose step precedes) and never mints a confirm of its own
// except the commit's own execution of the confirmed proposal:
//
//   · STAGE takes the pre-stage snapshot of MODE-SCOPED local state BEFORE
//     any state writes (staging writes no attach-state field — only the
//     journal entry); TRANSIENT verify-fail returns to staged with the
//     snapshot retained (re-verify needs NO fresh confirm — the human
//     confirmed the proposal, not the timing); STRUCTURAL verify-fail rolls
//     back AUTOMATICALLY to the pre-stage snapshot (local-only, idempotent,
//     hub-side untouched — invariant 1's sole automatic action).
//   · COMMIT is the only mode writer, and it writes through the machine's
//     human-confirm path; the commit-pending journal record is written
//     BEFORE any state write, so a kill mid-commit leaves the transition
//     journaled (restored-or-resumed, never torn). commit-pending renders as
//     a labeled badge and is bounded by a wall-clock cap that surfaces an
//     abort/resume choice confirmable locally, plus a local force-resolve
//     verb — no hub round-trip ever resolves a pending transition.
//   · The P4a-3 serialization SEAM (D2): the onVerifyEntry hook fires
//     BEFORE the attach test, once per verify attempt — the future
//     proposal queue drains there. No queue exists in this slice.
//   · Budgets are injectable (verify budget clamped UP to the #1034 60s
//     patience floor; pending cap) and clock-injectable: the F-harness
//     FakeClock drives every deadline — zero wall-clock waits in tests.

/** The verify outcome taxonomy (row 2): TRANSIENT is timing (return to
 *  staged, snapshot retained); STRUCTURAL is a world change (automatic
 *  rollback). */
export type VerifyOutcome =
  | { kind: "pass" }
  | { kind: "transient-fail"; detail: string }
  | { kind: "structural-fail"; detail?: string };

/** What the engine hands the attach test (and the P4a-3 drain hook): the
 *  confirmed transition + the clamped verify budget (the P4b fleet program
 *  composes these). */
export interface VerifyContext {
  transition: { id: string; from: AttachMode; to: AttachMode; reason?: string };
  budgetMs: number;
}

/** The engine's injectable budgets/thresholds (P4b composes them; base
 *  defaults ship). */
export interface ModeTransitionConfig {
  /** The attach-test budget. CLAMPED to VERIFY_BUDGET_FLOOR_MS from below —
   *  the #1034 60s patience is the floor, never less. */
  verifyBudgetMs: number;
  /** How long commit-pending may persist before the abort/resume choice
   *  surfaces. */
  pendingCapMs: number;
}

/** The #1034 patience — the verify budget floor. */
export const VERIFY_BUDGET_FLOOR_MS = 60_000;

/** The base defaults: the 60s verify floor + a 5-minute pending cap. */
export const DEFAULT_MODE_TRANSITION_CONFIG: ModeTransitionConfig = {
  verifyBudgetMs: VERIFY_BUDGET_FLOOR_MS,
  pendingCapMs: 300_000,
};

/** The engine's clock — the F-harness FakeClock shape, so every deadline
 *  (verify budget, pending cap) is FakeClock-driven in tests with zero
 *  wall-clock waits. */
export interface TransitionClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): { id: number };
  clearTimeout(handle: { id: number }): void;
}

/** The base wall-clock default. */
class WallClock implements TransitionClock {
  private seq = 0;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  now(): number {
    return Date.now();
  }

  setTimeout(callback: () => void, delayMs: number): { id: number } {
    const id = ++this.seq;
    this.timers.set(id, setTimeout(callback, delayMs));
    return { id };
  }

  clearTimeout(handle: { id: number }): void {
    const t = this.timers.get(handle.id);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(handle.id);
    }
  }
}

/** The kill-hook surface the engine invokes at its NAMED boundaries
 *  ("pre-commit" after verify before anything is written; "mid-commit" after
 *  the commit-pending journal record, before the apply) — the F-harness
 *  KillHookRegistry's structural type. */
export interface KillHookSurface {
  invoke(point: string): { kind: string } | undefined;
}

/** The engine's states: idle → staged → verified → committed, with
 *  commit-pending (journaled interruption) and rolled-back (the snapshot
 *  restored) as the honest resting states. commit-pending is a MODE-JOURNAL
 *  state — never a posture value (invariant 7). */
export type ModeTransitionEngineState =
  | "idle"
  | "staged"
  | "verified"
  | "commit-pending"
  | "committed"
  | "rolled-back";

/** The labeled-badge view of a journaled commit-pending transition: the
 *  pre-stage snapshot rendered live, the cap arithmetic, and the staged
 *  abort/resume choice once the cap elapses. */
export interface PendingTransitionView {
  badge: string;
  snapshot: TransitionSnapshot;
  capElapsed: boolean;
  choices: ["abort", "resume"] | null;
}

export interface ModeTransitionEngineOptions {
  machine: ModeMachine;
  /** The attach test: probes the tunnel/device and classifies the outcome. */
  verify: (ctx: VerifyContext) => Promise<VerifyOutcome> | VerifyOutcome;
  config?: Partial<ModeTransitionConfig>;
  clock?: TransitionClock;
  hooks?: KillHookSurface;
  /** P4a-3's serialization SEAM (D2): fires BEFORE the attach test, once
   *  per verify attempt — the future proposal queue drains here. A throwing
   *  drain leaves the transition STAGED (nothing written, nothing
   *  journaled for the attempt). */
  onVerifyEntry?: (ctx: VerifyContext) => Promise<void> | void;
}

const IN_FLIGHT_STATES: ReadonlySet<ModeTransitionEngineState> = new Set([
  "staged",
  "verified",
  "commit-pending",
]);

export class ModeTransitionEngine {
  private readonly machineValue: ModeMachine;
  private readonly verifyImpl: (ctx: VerifyContext) => Promise<VerifyOutcome> | VerifyOutcome;
  private readonly clockValue: TransitionClock;
  private readonly hooks: KillHookSurface | null;
  private readonly onVerifyEntry: ((ctx: VerifyContext) => Promise<void> | void) | null;
  private readonly configValue: ModeTransitionConfig;
  private stateValue: ModeTransitionEngineState = "idle";
  private haltedAtValue: "pre-commit" | "mid-commit" | null = null;
  private proposalValue: TransitionProposalRecord | null = null;
  private snapshotValue: TransitionSnapshot | null = null;
  private pendingSinceMs: number | null = null;

  constructor(opts: ModeTransitionEngineOptions) {
    this.machineValue = opts.machine;
    this.verifyImpl = opts.verify;
    this.clockValue = opts.clock ?? new WallClock();
    this.hooks = opts.hooks ?? null;
    this.onVerifyEntry = opts.onVerifyEntry ?? null;
    const merged: ModeTransitionConfig = {
      ...DEFAULT_MODE_TRANSITION_CONFIG,
      ...(opts.config ?? {}),
    };
    this.configValue = {
      // CLAMPED to the floor from below — the #1034 patience is never less
      verifyBudgetMs: Math.max(VERIFY_BUDGET_FLOOR_MS, merged.verifyBudgetMs),
      pendingCapMs: merged.pendingCapMs,
    };
    this.recoverFromJournal();
  }

  /** The effective budgets (clamped, base defaults shipped). */
  config(): ModeTransitionConfig {
    return { ...this.configValue };
  }

  state(): ModeTransitionEngineState {
    return this.stateValue;
  }

  /** Where a kill halted the engine ("pre-commit" | "mid-commit"), or null. */
  haltedAt(): "pre-commit" | "mid-commit" | null {
    return this.haltedAtValue;
  }

  /** The staged/retained pre-stage snapshot of the current or last
   *  transition (null before the first stage). */
  snapshot(): TransitionSnapshot | null {
    return this.snapshotValue;
  }

  /** The confirmed proposal the engine is executing (null before the first
   *  stage). */
  proposal(): TransitionProposalRecord | null {
    return this.proposalValue;
  }

  /** STAGE — the pre-stage snapshot FIRST, before any state writes (AC 1).
   *  Staging writes NO attach-state field: only the mode-journal entry. The
   *  snapshot pins the last human-confirmed mode config. */
  stage(input: {
    to: AttachMode;
    reason?: string;
    apply?: Record<string, unknown>;
    modeScopedFields?: string[];
  }): TransitionSnapshot {
    if (IN_FLIGHT_STATES.has(this.stateValue)) {
      throw new Error(`stage: a transition is already in flight (state "${this.stateValue}")`);
    }
    const current = this.machineValue.resolve().mode;
    if (input.to === current) {
      throw new Error(`stage: already confirmed in mode "${current}" — no transition to stage`);
    }
    const modeScopedFields = input.modeScopedFields ?? [];
    if (modeScopedFields.includes("posture")) {
      throw new Error(
        "stage: posture is transport-owned render state and is never mode-scoped (ADR-0005)",
      );
    }
    const raw = this.machineValue.record();
    const resolved = this.machineValue.resolve();
    const fields: Record<string, unknown> = {
      mode: current,
      state: raw.state !== undefined ? raw.state : legacyStateOf(current, resolved.posture),
    };
    for (const f of modeScopedFields) fields[f] = raw[f];
    const snapshot: TransitionSnapshot = { mode: current, fields };
    const proposal: TransitionProposalRecord = {
      id: randomUUID(),
      from: current,
      to: input.to,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.apply !== undefined ? { apply: { ...input.apply } } : {}),
      modeScopedFields: [...modeScopedFields],
    };
    this.snapshotValue = snapshot;
    this.proposalValue = proposal;
    this.pendingSinceMs = null;
    this.haltedAtValue = null;
    this.machineValue.appendJournal({
      kind: "transition-stage",
      from: proposal.from,
      to: proposal.to,
      snapshot,
      proposal,
      at: this.nowIso(),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    this.stateValue = "staged";
    return snapshot;
  }

  /** VERIFY — the attach test, bounded by the (clamped) verify budget.
   *  Re-runnable from staged AND verified (re-verify needs no fresh
   *  confirm). Throws synchronously when no transition is staged. */
  verify(): Promise<VerifyOutcome> {
    if (this.stateValue !== "staged" && this.stateValue !== "verified") {
      throw new Error(`verify: no staged transition to verify (state "${this.stateValue}")`);
    }
    return this.runVerify();
  }

  private async runVerify(): Promise<VerifyOutcome> {
    const proposal = this.proposalValue!;
    const budgetMs = this.configValue.verifyBudgetMs;
    const ctx: VerifyContext = {
      transition: {
        id: proposal.id,
        from: proposal.from,
        to: proposal.to,
        ...(proposal.reason !== undefined ? { reason: proposal.reason } : {}),
      },
      budgetMs,
    };
    // arm the deadline FIRST — the FakeClock drives it via advance() in the
    // same tick the caller gets the promise back; zero wall-clock waits
    let expire!: () => void;
    const expiry = new Promise<void>((resolve) => {
      expire = resolve;
    });
    const timer = this.clockValue.setTimeout(() => expire(), budgetMs);
    try {
      // the P4a-3 serialization SEAM (D2): the drain fires BEFORE the
      // attach test, once per verify attempt
      if (this.onVerifyEntry !== null) await this.onVerifyEntry(ctx);
      const winner = await Promise.race([
        Promise.resolve(this.verifyImpl(ctx)).then(
          (outcome): { tag: "outcome"; outcome: VerifyOutcome } => ({ tag: "outcome", outcome }),
        ),
        expiry.then((): { tag: "expired" } => ({ tag: "expired" })),
      ]);
      if (winner.tag === "expired") {
        // the budget expiring is TIMING, not a world change: transient
        const outcome: VerifyOutcome = {
          kind: "transient-fail",
          detail: `verify budget of ${budgetMs}ms expired before the attach test settled`,
        };
        this.journalVerify(outcome);
        this.stateValue = "staged"; // return to staged — the snapshot retained
        return outcome;
      }
      const outcome = winner.outcome;
      this.journalVerify(outcome);
      if (outcome.kind === "pass") {
        this.stateValue = "verified";
        return outcome;
      }
      if (outcome.kind === "transient-fail") {
        // return to staged with the snapshot retained; re-verify needs NO
        // fresh confirm — the human confirmed the proposal, not the timing
        this.stateValue = "staged";
        return outcome;
      }
      // STRUCTURAL: a world change — automatic rollback to the pre-stage
      // snapshot (local-only, idempotent, hub-side untouched)
      this.applyRollback(
        `structural verify-fail${outcome.detail !== undefined ? `: ${outcome.detail}` : ""}`,
      );
      return outcome;
    } finally {
      this.clockValue.clearTimeout(timer);
    }
  }

  private journalVerify(outcome: VerifyOutcome): void {
    this.machineValue.appendJournal({
      kind: "transition-verify",
      outcome: outcome.kind,
      ...(outcome.kind !== "pass" && outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      at: this.nowIso(),
    });
  }

  /** COMMIT — the only mode writer: atomic + journalled, through the
   *  machine's human-confirm path (the proposal was human-confirmed; the
   *  commit executes it). The commit-pending journal record is written
   *  BEFORE any state write — a kill mid-commit leaves the transition
   *  journaled (restored-or-resumed), never torn. */
  commit(): void {
    if (this.stateValue !== "verified") {
      throw new Error(`commit: the transition is not verified (state "${this.stateValue}")`);
    }
    const proposal = this.proposalValue!;
    const snapshot = this.snapshotValue!;
    // named boundary "pre-commit": after verify, BEFORE anything is written
    // — a kill here leaves nothing applied and nothing journaled
    const pre = this.hooks?.invoke("pre-commit");
    if (pre !== undefined) {
      this.haltedAtValue = "pre-commit";
      return;
    }
    // the point of no return: journal commit-pending BEFORE any state write
    const sinceMs = this.clockValue.now();
    this.pendingSinceMs = sinceMs;
    this.machineValue.appendJournal({
      kind: "transition-commit-pending",
      to: proposal.to,
      snapshot,
      proposal,
      sinceMs,
      at: this.nowIso(),
    });
    this.stateValue = "commit-pending";
    // named boundary "mid-commit": the journal record written, the apply
    // not yet run — a kill here leaves commit-pending, never torn
    const mid = this.hooks?.invoke("mid-commit");
    if (mid !== undefined) {
      this.haltedAtValue = "mid-commit";
      return;
    }
    this.completeCommit();
  }

  /** Resume after a halt (the proposal was human-confirmed — no fresh
   *  confirm): a pre-commit halt retries the commit; a commit-pending halt
   *  (or a crash recovered from the journal) replays to committed. */
  resume(): void {
    if (this.stateValue === "verified") {
      this.haltedAtValue = null;
      this.commit();
      return;
    }
    if (this.stateValue === "commit-pending") {
      this.completeCommit();
      return;
    }
    throw new Error(`resume: nothing to resume (state "${this.stateValue}")`);
  }

  /** The labeled-badge view of the journaled commit-pending transition: the
   *  pre-stage snapshot rendered live, the cap arithmetic, and the staged
   *  abort/resume choice once the cap elapses. Null when nothing is
   *  pending. The POSTURE field never carries any of this (invariant 7). */
  pending(): PendingTransitionView | null {
    if (this.stateValue !== "commit-pending") return null;
    if (this.snapshotValue === null || this.proposalValue === null) return null;
    const capElapsed = this.capElapsed();
    return {
      badge: `commit-pending: ${this.snapshotValue.mode} → ${this.proposalValue.to} (mid-commit halt; the badge is the mode journal's state, never a posture value)`,
      snapshot: this.snapshotValue,
      capElapsed,
      choices: capElapsed ? ["abort", "resume"] : null,
    };
  }

  /** The cap-surfaced abort/resume choice, confirmable LOCALLY (no hub
   *  round-trip resolves a pending transition). Refuses before the cap —
   *  forceResolvePending is the cap-free local verb. */
  resolvePending(action: "abort" | "resume"): void {
    if (this.stateValue !== "commit-pending") {
      throw new Error(`resolvePending: no commit-pending transition (state "${this.stateValue}")`);
    }
    if (!this.capElapsed()) {
      throw new Error(
        `resolvePending: the wall-clock cap (${this.configValue.pendingCapMs}ms) has not elapsed — the choice is not surfaced yet; forceResolvePending is the local verb`,
      );
    }
    this.resolvePendingVia(action, "cap-choice");
  }

  /** The local force-resolve verb: abort or resume a journaled
   *  commit-pending WITHOUT the cap and WITHOUT the hub. */
  forceResolvePending(action: "abort" | "resume"): void {
    if (this.stateValue !== "commit-pending") {
      throw new Error(`forceResolvePending: no commit-pending transition (state "${this.stateValue}")`);
    }
    this.resolvePendingVia(action, "force");
  }

  /** Explicit rollback to the pre-stage snapshot (also the automatic path
   *  for structural verify-fails and abort resolutions). Idempotent: a
   *  rollback from rolled-back is a no-op that writes and journals
   *  nothing. */
  rollback(reason?: string): { rolledBack: boolean; restoredFields: string[] } {
    if (this.stateValue === "rolled-back") {
      return { rolledBack: false, restoredFields: [] }; // idempotent no-op
    }
    if (this.stateValue !== "staged" && this.stateValue !== "verified") {
      throw new Error(
        `rollback: no in-flight transition to roll back (state "${this.stateValue}")` +
          (this.stateValue === "commit-pending"
            ? " — resolve the pending transition via resolvePending/forceResolvePending"
            : ""),
      );
    }
    return this.applyRollback(reason ?? "explicit rollback");
  }

  private resolvePendingVia(action: "abort" | "resume", via: "force" | "cap-choice"): void {
    this.machineValue.appendJournal({
      kind: "transition-resolve",
      action,
      via,
      at: this.nowIso(),
    });
    this.pendingSinceMs = null;
    if (action === "resume") {
      this.completeCommit();
    } else {
      this.applyRollback(`commit-pending resolved: abort (via ${via})`);
    }
  }

  private completeCommit(): void {
    const proposal = this.proposalValue!;
    // the ONLY mode write: the human-confirmed commit path — commit executes
    // the confirmed proposal through the machine's confirmMode
    this.machineValue.confirmMode(
      proposal.to,
      proposal.reason ?? `transition-commit ${proposal.id}`,
    );
    if (proposal.apply !== undefined) {
      this.machineValue.overlayRewrite(proposal.apply);
    }
    this.machineValue.appendJournal({ kind: "transition-commit", to: proposal.to, at: this.nowIso() });
    this.stateValue = "committed";
    this.haltedAtValue = null;
    this.pendingSinceMs = null;
  }

  private applyRollback(reason: string): { rolledBack: boolean; restoredFields: string[] } {
    const snapshot = this.snapshotValue!;
    // restoration, not mutation: local-only, idempotent, hub-side untouched
    const { restored } = this.machineValue.restoreModeScoped(snapshot.fields);
    this.machineValue.appendJournal({
      kind: "transition-rollback",
      restored: snapshot.mode,
      at: this.nowIso(),
      reason,
    });
    this.stateValue = "rolled-back";
    this.haltedAtValue = null;
    this.pendingSinceMs = null;
    return { rolledBack: true, restoredFields: restored };
  }

  private capElapsed(): boolean {
    if (this.pendingSinceMs === null) return false;
    return this.clockValue.now() - this.pendingSinceMs >= this.configValue.pendingCapMs;
  }

  /** Process-death recovery: a FRESH engine on the same machine recovers an
   *  unresolved commit-pending transition from the MODE journal — the
   *  journal record restores or resumes, never half-applies. */
  private recoverFromJournal(): void {
    let open: Extract<ModeJournalEntry, { kind: "transition-commit-pending" }> | null = null;
    for (const entry of this.machineValue.journal()) {
      if (entry.kind === "transition-commit-pending") open = entry;
      else if (entry.kind === "transition-commit" || entry.kind === "transition-resolve") {
        open = null; // the pending transition was resolved
      }
    }
    if (open === null) return;
    this.stateValue = "commit-pending";
    this.haltedAtValue = "mid-commit";
    this.snapshotValue = open.snapshot;
    this.proposalValue = open.proposal;
    this.pendingSinceMs = open.sinceMs;
  }

  private nowIso(): string {
    return new Date(this.clockValue.now()).toISOString();
  }
}

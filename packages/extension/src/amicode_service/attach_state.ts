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
// This module therefore keeps TWO distinct logs and NO serialization
// machinery of its own (the engine is P4a-2, the queue is P4a-3 — neither is
// this slice):
//   · writeLog() — an in-memory render record (who wrote what, when) for
//     surfacing and the F3 fixture; NOT a journal, never persisted, exempt.
//   · journal() — the MODE journal surface where P4a-2 will persist
//     stage/verify/commit states and commit-pending. Posture writes NEVER
//     land in it. Human confirms are the only entries this slice records.
//
// Preserve-on-rewrite (the substrate's bidirectional invariant, carried
// across the split unchanged): a base rewrite preserves overlay-written
// fields it does not understand, and an overlay rewrite preserves
// base-written fields — never clobbers in either direction.
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
  writer: "transport" | "human-confirm" | "overlay";
  /** The machine-owned field the write named: "posture" | "mode" — or
   *  "overlay-fields" for the overlay data path. */
  field: "posture" | "mode" | "overlay-fields";
  /** The value written (mode/posture writes; null for overlay rewrites). */
  value: string | null;
  at: string;
  reason?: string;
}

/** A MODE journal entry (P4a-2's two-phase engine grows this surface; this
 *  slice records only human confirms — posture writes are exempt). */
export interface ModeJournalEntry {
  kind: "human-confirm";
  mode: AttachMode;
  at: string;
  reason?: string;
}

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
   *  fields while preserving the machine-owned mode/posture/state — never
   *  clobbers in either direction. */
  overlayRewrite(patch: Record<string, unknown>): void {
    const dataOnly: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (MACHINE_OWNED_FIELDS.has(k)) continue;
      dataOnly[k] = v;
    }
    this.recordValue = mergeAttachState(this.recordValue, dataOnly);
    this.writes.push({ writer: "overlay", field: "overlay-fields", value: null, at: this.now() });
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

  /** The MODE journal surface (P4a-2 persists stage/verify/commit and
   *  commit-pending here). Posture writes NEVER land in it — the render-only
   *  exemption, asserted in tests. */
  journal(): ModeJournalEntry[] {
    return [...this.journalEntries];
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

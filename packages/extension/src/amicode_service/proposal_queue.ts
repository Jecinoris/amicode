// PROPOSAL QUEUE (#1092 — fleet rearchitect P4a-3; spec
// spec-20260913-114814 §0.1 mutations-of-consequence, D2 the FULL queue
// rule, §2.2 row 3's escalation, invariant 5's idempotency, §8 F9): the
// base machinery for DURABLE DEVICE-LOCAL STAGED PROPOSALS.
//
// Offline, a mutation-of-consequence (a mode change, a checkout/return, a
// fleet write to a hub-resident session, a topology edit — the §0.1
// enumerated set) has no honest path: it either fails or silently drops.
// Here it degrades to a STAGED PROPOSAL — durably stored on this device,
// never applied while offline — and on reconnect the queue DRAINS at the
// mode machine's verify-entry seam (#1087's `onVerifyEntry`, which fires
// once per verify attempt BEFORE the attach test): each proposal RE-VERIFIES
// its preconditions against freshly fetched truth, then applies or returns
// to its resting state, all BEFORE the mode machine's verify begins (D2's
// serialization rule).
//
// The rules this module owns (D2, verbatim semantics):
//   · A precondition CHANGE is a world change: the proposal renames to
//     `pending-reconfirm` and is NEVER applied — only a human re-confirm (a
//     fresh confirm stamp = a new identity) revives it.
//   · A FETCH FAILURE is NOT a world change: the proposal is marked
//     `blocked-degraded`, the posture field goes `degraded` (written through
//     the mode machine's posture path — render-only, exempt), a BOUNDED
//     retry is scheduled on the injectable clock, and there is NO rename to
//     pending-reconfirm.
//   · Blocked-degraded NEVER WEDGES the drain: a fetch-blocked proposal
//     cannot re-verify while its transport is down, so the drain proceeds
//     when the next proposal's preconditions are locally verifiable, and
//     blocked-degraded entries surface individually.
//   · APPLIES ARE IDEMPOTENT by portable client request identity (invariant
//     5): identity = content hash (type + payload + precondition) + the
//     ORIGINAL confirm stamp — portable across devices, the dedupe key. A
//     duplicate apply by identical identity is a no-op returning the prior
//     result. The cross-device dedupe (a re-confirm on a second device
//     against the first's applied identity) is the APPLY TARGET's, keyed on
//     the same portable identity — the queue stamps every apply with it.
//   · THE SERIALIZATION HOLD: while the mode machine is between verify and
//     commit (the engine's additive `onCommitWindow` hook — THE sanctioned
//     engine change of #1092), applies are held; the window closing triggers
//     a release drain that re-verifies and applies. The two machines never
//     interleave — a held apply never executes against a half-committed
//     mode transition.
//   · STRUCTURAL EVENTS ENQUEUE (row 3): the classifier's typed structural
//     signals (auth-revoked, presumed-structural, mode-changed-elsewhere)
//     land as `structural-surface` proposals — a SURFACE for the human,
//     never auto-applied. The drain re-verifies the claim: it persists →
//     retained (surfaced); the world recovered → resolved and dropped.
//
// The apply target is an INJECTABLE EXECUTOR SEAM (`ProposalExecutor`) —
// mode proposals apply via the engine's confirm path and fleet-write/
// topology proposals via the versioned verb contract, but those real
// executors arrive with P3b-2/P6; this slice ships the interface, tested
// with mocks. Every apply carries the fleet verb contract version —
// consumed from @amicode/schema, never re-defined here — and a
// stale-contract apply is rejected LOUDLY naming both versions (the hub
// keeps executing the version it speaks; the rejection surfaces, the drain
// does not wedge).
//
// The store is DEVICE-LOCAL, DURABLE, CRASH-SAFE: a single JSON file at an
// INJECTABLE path (the live layout precedent is ~/.amico/ops/fleet/ — the
// composition supplies the path; nothing in this module ever touches the
// home dir), written via write-temp-rename with the F-harness's
// deterministic kill at the named mid-write boundary ("pre-rename": the tmp
// written, the rename not yet run — a kill there leaves the PRIOR file
// intact). All timing — the bounded retry backoff — runs on the injectable
// TransitionClock (the F-harness FakeClock satisfies it structurally):
// ZERO wall-clock in tests.
//
// Reading conventions: ADR-0005's vocabulary law holds throughout — the
// queue never writes the mode field (the only mode writer is the engine's
// human-confirmed commit path), its fetch-failure posture write rides the
// machine's render-only posture path, and `blocked-degraded` /
// `pending-reconfirm` are QUEUE record states, never attach-state values.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ModeMachine,
  type KillHookSurface,
  type StructuralSignalClass,
  type TransitionClock,
  type VerifyContext,
} from "./attach_state";
import { FLEET_CONTRACT_VERSION, FleetContractVersionError } from "@amicode/schema";

// ── the record vocabulary ─────────────────────────────────────────────────────

/** The §0.1 enumerated mutations-of-consequence set — the only things that
 *  queue — plus row 3's structural-surface (the escalation surface: an
 *  auth-revoked / presumed-structural signal surfaced as a staged proposal,
 *  never auto-applied; row 3's own language, "surfaced as a staged
 *  proposal"). Closed on purpose: nothing else queues (§0.1). */
export type ProposalType =
  | "mode-change" // §0.1: mode changes (enroll/detach)
  | "checkout" // §0.1: checkout
  | "return" // §0.1: return
  | "fleet-write" // §0.1: fleet writes to hub-resident sessions (write-intent bytes)
  | "topology-edit" // §0.1: device enrollment / topology edits
  | "structural-surface"; // row 3: the escalation surface (never auto-applied)

export const PROPOSAL_TYPES: readonly ProposalType[] = [
  "mode-change",
  "checkout",
  "return",
  "fleet-write",
  "topology-edit",
  "structural-surface",
];

/** The resting states of a queued proposal. `blocked-degraded` = its truth
 *  fetch is down (a fetch failure, NOT a world change); `pending-reconfirm`
 *  = the preconditions CHANGED — never applied until a human re-confirms.
 *  These are QUEUE record states, never attach-state values (ADR-0005). */
export type ProposalState = "staged" | "blocked-degraded" | "pending-reconfirm";

export const PROPOSAL_STATES: readonly ProposalState[] = [
  "staged",
  "blocked-degraded",
  "pending-reconfirm",
];

/** The checkable claim a proposal re-verifies against freshly fetched truth
 *  on every drain. `claim` names what the truth fetch measures;
 *  `expected` is the world AS THE HUMAN CONFIRMED IT — a fetched truth that
 *  differs is a world change (pending-reconfirm, never applied). */
export interface ProposalPrecondition {
  claim: string;
  expected: unknown;
}

/** The PORTABLE client request identity (invariant 5): the proposal's
 *  content hash + the ORIGINAL human confirm stamp. Portable across
 *  devices — the same confirm staged on a second device yields the same
 *  identity — and the dedupe key everywhere (staging, in-flight, receipts,
 *  the apply target's own cross-device dedupe). */
export interface ProposalIdentity {
  contentHash: string;
  confirmStamp: string;
}

/** One durable queued proposal. */
export interface QueuedProposal {
  /** Local record id (device-local uuid — NOT portable; the identity is). */
  id: string;
  type: ProposalType;
  payload: Record<string, unknown>;
  precondition: ProposalPrecondition;
  identity: ProposalIdentity;
  /** The fleet verb contract version the apply carries (invariant 5). */
  contractVersion: number;
  state: ProposalState;
  /** False only for structural-surface: a surface for the human, never
   *  auto-applied (row 3). */
  autoApply: boolean;
  /** Fetch attempts since staging — the bounded retry budget is consumed
   *  against `maxRetries`. */
  attempts: number;
  enqueuedAt: string;
  updatedAt: string;
  /** The last fetch failure (provenance while blocked-degraded). */
  lastError?: string;
  /** The loud stale-contract rejection message, when one landed. */
  rejection?: string;
}

/** An applied identity — the durable dedupe ledger. A duplicate apply by
 *  identical identity is a no-op returning the prior result. */
export interface ApplyReceipt {
  identityKey: string;
  result: unknown;
  at: string;
}

/** The durable store file: the queued proposals + the applied receipts. */
export interface ProposalStoreFile {
  version: 1;
  proposals: QueuedProposal[];
  applied: ApplyReceipt[];
}

export const PROPOSAL_STORE_VERSION = 1;

/** The canonical identity key — the portable dedupe key: content hash +
 *  confirm stamp. Exported so the executor seam (and its tests) key on the
 *  SAME identity the queue stamps every apply with. */
export function identityKeyOf(identity: ProposalIdentity): string {
  return `${identity.contentHash}:${identity.confirmStamp}`;
}

// ── the durable store (write-temp-rename; the F-harness kill at the named
// mid-write boundary leaves the prior file intact) ────────────────────────────

/** The device-local durable proposal store. One JSON file at an INJECTABLE
 *  path (tests inject tmp paths — nothing here ever touches the home dir);
 *  `save` is atomic via write-temp-rename, and invokes the kill hook at the
 *  named "pre-rename" boundary (the tmp written, the rename not yet run) —
 *  a kill there leaves the PRIOR file intact; the orphaned tmp is never
 *  loaded (only the target path is read). A corrupt or unversioned file
 *  fails LOUD on load — never a silent reset (the honest posture: the
 *  staged proposals are durable data, a torn file means disk corruption,
 *  not an empty queue). */
export class ProposalStore {
  private readonly path: string;
  private readonly hooks: KillHookSurface | null;

  constructor(opts: { path: string; hooks?: KillHookSurface }) {
    this.path = opts.path;
    this.hooks = opts.hooks ?? null;
  }

  load(): ProposalStoreFile {
    if (!existsSync(this.path)) {
      return { version: PROPOSAL_STORE_VERSION, proposals: [], applied: [] };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (err) {
      throw new Error(
        `proposal store file is corrupt (${this.path}): ${err instanceof Error ? err.message : String(err)} — refusing loudly, never a silent reset`,
      );
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(`proposal store file is corrupt (${this.path}): not a JSON object`);
    }
    const carrier = doc as Partial<ProposalStoreFile>;
    if (carrier.version !== PROPOSAL_STORE_VERSION) {
      throw new Error(
        `proposal store carries unsupported version ${JSON.stringify(carrier.version) ?? String(carrier.version)}; this store speaks v${PROPOSAL_STORE_VERSION}`,
      );
    }
    if (!Array.isArray(carrier.proposals) || !Array.isArray(carrier.applied)) {
      throw new Error(`proposal store file is corrupt (${this.path}): proposals/applied must be arrays`);
    }
    return { version: PROPOSAL_STORE_VERSION, proposals: carrier.proposals, applied: carrier.applied };
  }

  save(file: ProposalStoreFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2));
    // the named mid-write boundary: the tmp is written, the rename has NOT
    // run — the F-harness's deterministic kill here leaves the PRIOR file
    // intact (a "stop" halts the save; a crash/throw propagates — the prior
    // file survives either way)
    const ev = this.hooks?.invoke("pre-rename");
    if (ev !== undefined) return; // halted mid-write: no rename, the prior file stands
    renameSync(tmp, this.path);
  }
}

// ── the executor seam (the injectable apply target) ──────────────────────────

/** The apply target for one re-verified proposal. Real executors arrive
 *  with P3b-2/P6: mode proposals apply via the engine's confirm path;
 *  fleet-write / topology proposals execute against the versioned verb
 *  contract. The seam's contract: the queue hands the proposal WITH its
 *  portable identity, the executor's own dedupe keys on that identity
 *  (invariant 5 — the cross-device double-confirm is deduped HERE, at the
 *  shared apply target, never device-locally), and apply results are JSON
 *  data (they persist as the receipt the duplicate re-confirm returns). */
export interface ProposalExecutor {
  apply(proposal: QueuedProposal): Promise<unknown> | unknown;
}

// ── the queue's injectable config ────────────────────────────────────────────

export interface ProposalQueueConfig {
  /** The bounded retry budget: total truth-fetch attempts per blocked
   *  episode (the initial drain's attempt counts). After the budget the
   *  proposal stays blocked-degraded — surfaced, never re-fetched until a
   *  human re-confirm revives it (a fresh stamp = a new identity). */
  maxRetries: number;
  /** The first retry's backoff delay; each further failure doubles it. */
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

export const DEFAULT_PROPOSAL_QUEUE_CONFIG: ProposalQueueConfig = {
  maxRetries: 3,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 30_000,
};

/** The row-3 structural classes that enqueue proposals. The default is all
 *  three (auth-revoked, presumed-structural, mode-changed-elsewhere — row
 *  3's escalation set); the composition may narrow it. */
const DEFAULT_STRUCTURAL_CLASSES: StructuralSignalClass[] = [
  "auth-revoked",
  "mode-changed-elsewhere",
  "presumed-structural",
];

/** What one enqueue call returns. `alreadyApplied` = the identity is in the
 *  receipts ledger: the duplicate apply was a NO-OP and `priorResult` carries
 *  the prior result. `deduped` = an identical identity is already staged or
 *  applied: nothing new was recorded. */
export interface EnqueueResult {
  proposal: QueuedProposal | null;
  deduped: boolean;
  alreadyApplied: boolean;
  priorResult?: unknown;
}

export interface ProposalEnqueueInput {
  type: ProposalType;
  payload: Record<string, unknown>;
  precondition: ProposalPrecondition;
  /** The ORIGINAL human confirm stamp — the portable half of the identity. */
  confirmStamp: string;
  /** Overrides the stamped fleet verb contract version (a proposal loaded
   *  from an older/newer build carries its own; absent = current). */
  contractVersion?: number;
}

/** One drain's report — every examined proposal's disposition. */
export interface DrainReport {
  /** Proposals examined this drain. */
  drained: number;
  /** Applied this drain (executor called, receipt recorded, removed). */
  applied: string[];
  /** Applies deferred by the serialization hold — still staged, re-verified
   *  on the release drain when the engine's commit window closes. */
  held: string[];
  /** Precondition CHANGED (or already resting there) — never applied. */
  pendingReconfirm: string[];
  /** Fetch failed this drain (or the retry budget is exhausted) — surfaced
   *  individually, never wedging the drain. */
  blockedDegraded: string[];
  /** Stale-contract rejections — each message names BOTH versions. */
  rejected: { id: string; message: string }[];
  /** structural-surface claims that still hold — retained, surfaced. */
  surfaceRetained: string[];
  /** structural-surface claims the world recovered from — resolved, dropped. */
  surfaceResolved: string[];
}

// ── internals: canonical JSON (the content hash and the deep-equal both
// key on it — payload/precondition/truth are JSON data) ─────────────────────

function canonicalize(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalize(val)}`).join(",")}}`;
}

/** Structural JSON equality — the precondition re-verify's comparison. */
function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v) ?? "null") as T;
}

/** The wall-clock default (the F-harness FakeClock satisfies the
 *  TransitionClock shape structurally; tests never run on this one). */
class QueueWallClock implements TransitionClock {
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

// ── the queue ────────────────────────────────────────────────────────────────

/** The durable device-local proposal queue: staging (offline), draining
 *  (at the engine's verify-entry seam — the queue drains fully BEFORE the
 *  mode machine's verify begins), the serialization hold through the
 *  engine's verify→commit window, and the structural-event subscription.
 *
 *  Composition: hand `queueDrainHook(queue)` to the engine's
 *  `onVerifyEntry` and `queueHoldHook(queue)` to its `onCommitWindow` — the
 *  queue owns the drain and hold implementations, the engine owns the
 *  firing points (chosen: a composition wrapper, not engine surgery — the
 *  engine's interface makes the callbacks the natural seam).
 */
export class ProposalQueue {
  private readonly machine: ModeMachine;
  private readonly store: ProposalStore;
  private readonly executor: ProposalExecutor;
  private readonly fetchTruthImpl: (proposal: QueuedProposal) => Promise<unknown> | unknown;
  private readonly clockValue: TransitionClock;
  private readonly configValue: ProposalQueueConfig;
  private readonly structuralClasses: StructuralSignalClass[];
  private readonly unsubscribeStructural: () => void;
  private fileValue: ProposalStoreFile | null = null;
  /** Every drain/flush chains here — `idle()` awaits it (drains never
   *  interleave: the chain IS the serialization). */
  private activity: Promise<void> = Promise.resolve();
  /** In-flight applies by identity — a concurrent apply of the same identity
   *  shares ONE execution. */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /** The serialization hold latch (the engine's commit window). */
  private holdActive = false;
  /** The tripwire: executor invocations for an identity this queue already
   *  had a receipt/in-flight for. Zero by construction — asserted as the
   *  F9 metric from the queue side. */
  private duplicateApplies = 0;
  private lastDrainError: Error | null = null;

  constructor(opts: {
    machine: ModeMachine;
    store: ProposalStore;
    executor: ProposalExecutor;
    /** Re-verify's truth source: returns the fresh truth for the proposal's
     *  precondition claim; THROWS on a fetch failure (which is NOT a world
     *  change — blocked-degraded, never pending-reconfirm). Locally
     *  verifiable proposals get a fetcher that reads local state. */
    fetchTruth: (proposal: QueuedProposal) => Promise<unknown> | unknown;
    clock?: TransitionClock;
    config?: Partial<ProposalQueueConfig>;
    /** The row-3 classes that enqueue (default: all three). */
    structuralClasses?: StructuralSignalClass[];
  }) {
    this.machine = opts.machine;
    this.store = opts.store;
    this.executor = opts.executor;
    this.fetchTruthImpl = opts.fetchTruth;
    this.clockValue = opts.clock ?? new QueueWallClock();
    this.configValue = { ...DEFAULT_PROPOSAL_QUEUE_CONFIG, ...(opts.config ?? {}) };
    this.structuralClasses = opts.structuralClasses ?? DEFAULT_STRUCTURAL_CLASSES;
    // row 3: the machine's typed structural events land as staged proposals
    // (structural-surface — never auto-applied). Nothing beyond
    // emission+enqueue happens offline.
    this.unsubscribeStructural = this.machine.onStructural((signal) => {
      if (!this.structuralClasses.includes(signal.class)) return;
      this.enqueue({
        type: "structural-surface",
        payload: {
          class: signal.class,
          ...(signal.detail !== undefined ? { detail: signal.detail } : {}),
        },
        precondition: { claim: `structural:${signal.class}`, expected: { class: signal.class } },
        confirmStamp: signal.at,
      });
    });
  }

  /** Stage a proposal (offline-safe: durable only, never applied here).
   *  Dedupes by portable identity against both the staged queue and the
   *  applied receipts — a duplicate re-confirm of an applied identity is a
   *  no-op returning the prior result. */
  enqueue(input: ProposalEnqueueInput): EnqueueResult {
    const file = this.ensureFile();
    const contentHash = createHash("sha256")
      .update(canonicalize({ type: input.type, payload: input.payload, precondition: input.precondition }))
      .digest("hex");
    const identity: ProposalIdentity = { contentHash, confirmStamp: input.confirmStamp };
    const key = identityKeyOf(identity);
    const receipt = file.applied.find((r) => r.identityKey === key);
    if (receipt !== undefined) {
      // invariant 5: the duplicate apply is a NO-OP returning the prior result
      return { proposal: null, deduped: true, alreadyApplied: true, priorResult: receipt.result };
    }
    const existing = file.proposals.find((p) => identityKeyOf(p.identity) === key);
    if (existing !== undefined) {
      return { proposal: clone(existing), deduped: true, alreadyApplied: false };
    }
    const now = this.nowIso();
    const record: QueuedProposal = {
      id: randomUUID(),
      type: input.type,
      payload: clone(input.payload),
      precondition: clone(input.precondition),
      identity,
      contractVersion: input.contractVersion ?? FLEET_CONTRACT_VERSION,
      state: "staged",
      autoApply: input.type !== "structural-surface",
      attempts: 0,
      enqueuedAt: now,
      updatedAt: now,
    };
    file.proposals.push(record);
    this.save();
    return { proposal: clone(record), deduped: false, alreadyApplied: false };
  }

  /** Drain the queue: every staged proposal re-verifies against freshly
   *  fetched truth, then applies or rests. Runs serialized (chained on the
   *  activity chain — drains never interleave each other). A corrupt store
   *  or a throwing executor rejects loudly — the engine's verify-entry
   *  drain leaves the mode transition STAGED in that case (D2: the queue
   *  drains fully BEFORE mode verify begins, or not at all). */
  drain(): Promise<DrainReport> {
    const run = this.activity.then(() => this.runDrain());
    this.activity = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Await every chained drain/flush (the release drain included). */
  idle(): Promise<void> {
    return this.activity.then(() => undefined);
  }

  /** The serialization HOLD (the engine's verify→commit window opened):
   *  applies are deferred — a drain that reaches an apply for a
   *  verified-good proposal leaves it staged, and the window closing
   *  triggers the release drain that re-verifies it freshly. Idempotent. */
  hold(_reason: string): void {
    void _reason;
    this.holdActive = true;
  }

  /** The window closed: run the release drain — held proposals re-verify
   *  against post-commit truth and apply. (Never trust a verification made
   *  inside the window: the commit itself changed the world.) */
  release(reason: string): Promise<DrainReport> {
    void reason;
    this.holdActive = false;
    return this.drain();
  }

  /** The queued proposals (surfacing: blocked-degraded and
   *  pending-reconfirm entries surface individually). */
  proposals(): QueuedProposal[] {
    return clone(this.ensureFile().proposals);
  }

  /** The applied receipts (the durable dedupe ledger). */
  receipts(): ApplyReceipt[] {
    return clone(this.ensureFile().applied);
  }

  /** The queue-side idempotency metric: executor invocations for an
   *  identity the queue had already applied or had in flight. Zero by
   *  construction — the F9 assertion; the cross-device half of the metric
   *  lives at the shared apply target, keyed on the same portable identity. */
  stats(): { n_duplicate_applies: number; lastDrainError: Error | null } {
    return { n_duplicate_applies: this.duplicateApplies, lastDrainError: this.lastDrainError };
  }

  /** Detach from the machine's structural surface (teardown). */
  dispose(): void {
    this.unsubscribeStructural();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private ensureFile(): ProposalStoreFile {
    if (this.fileValue === null) this.fileValue = this.store.load(); // corrupt → loud throw
    return this.fileValue;
  }

  private save(): void {
    if (this.fileValue !== null) this.store.save(this.fileValue);
  }

  private nowIso(): string {
    return new Date(this.clockValue.now()).toISOString();
  }

  private async runDrain(): Promise<DrainReport> {
    const file = this.ensureFile(); // a corrupt store rejects the drain loudly
    const report: DrainReport = {
      drained: file.proposals.length,
      applied: [],
      held: [],
      pendingReconfirm: [],
      blockedDegraded: [],
      rejected: [],
      surfaceRetained: [],
      surfaceResolved: [],
    };
    // iterate a snapshot: an apply removes from the live file mid-loop
    for (const p of [...file.proposals]) {
      if (!file.proposals.some((q) => q.id === p.id)) continue; // removed earlier this drain
      // resting states first: pending-reconfirm needs a HUMAN re-confirm
      // (a fresh stamp = a new identity); an exhausted blocked-degraded is
      // surfaced, never re-fetched — neither wedges the drain
      if (p.state === "pending-reconfirm") {
        report.pendingReconfirm.push(p.id);
        continue;
      }
      if (p.state === "blocked-degraded" && p.attempts >= this.configValue.maxRetries) {
        report.blockedDegraded.push(p.id);
        continue;
      }
      // the versioned verb contract gate: a stale-contract apply is
      // rejected LOUDLY (naming both versions — @amicode/schema's
      // semantics, consumed) and surfaces; it never wedges the drain
      if (p.autoApply && p.contractVersion !== FLEET_CONTRACT_VERSION) {
        const err = new FleetContractVersionError(p.contractVersion);
        p.rejection = err.message;
        p.updatedAt = this.nowIso();
        this.save();
        report.rejected.push({ id: p.id, message: err.message });
        continue;
      }
      // re-verify against FRESHLY FETCHED truth
      let actual: unknown;
      try {
        actual = await this.fetchTruthImpl(p);
      } catch (err) {
        // a fetch failure is NOT a world change: blocked-degraded + posture
        // degraded (the machine's render-only posture path) + bounded
        // retry + NO rename to pending-reconfirm
        p.state = "blocked-degraded";
        p.attempts += 1;
        p.lastError = err instanceof Error ? err.message : String(err);
        p.updatedAt = this.nowIso();
        this.machine.writePosture(
          "degraded",
          `proposal ${p.id} (${p.type}) re-verify fetch failed: ${p.lastError} — a fetch failure is not a world change (D2)`,
        );
        this.save();
        report.blockedDegraded.push(p.id);
        this.scheduleRetry(p);
        continue; // never a wedge: the drain proceeds to the next proposal
      }
      // the fetch succeeded: a previously blocked entry re-enters the honest path
      if (p.state === "blocked-degraded") {
        p.state = "staged";
        p.updatedAt = this.nowIso();
        this.save();
      }
      const holds = deepEqual(actual, p.precondition.expected);
      // structural-surface: a surface for the human — NEVER auto-applied
      // (row 3). The claim persists → retained; the world recovered →
      // resolved and dropped (the classifier's episode ended).
      if (!p.autoApply) {
        if (holds) {
          report.surfaceRetained.push(p.id);
        } else {
          this.fileValue!.applied.push({
            identityKey: identityKeyOf(p.identity),
            result: { resolved: "the structural claim no longer holds — the episode ended" },
            at: this.nowIso(),
          });
          this.fileValue!.proposals = this.fileValue!.proposals.filter((q) => q.id !== p.id);
          this.save();
          report.surfaceResolved.push(p.id);
        }
        continue;
      }
      if (!holds) {
        // a precondition CHANGE is a world change: pending-reconfirm, NEVER applied
        p.state = "pending-reconfirm";
        p.updatedAt = this.nowIso();
        this.save();
        report.pendingReconfirm.push(p.id);
        continue;
      }
      if (this.holdActive) {
        // the engine's verify→commit window is open: the apply is HELD —
        // the proposal stays staged and the release drain (on window close)
        // re-verifies it against post-commit truth before applying. The
        // two machines never interleave.
        report.held.push(p.id);
        continue;
      }
      await this.applyProposal(p);
      report.applied.push(p.id);
    }
    return report;
  }

  /** Apply one verified proposal — idempotent by portable identity, at
   *  every layer this device can see: in-flight applies share ONE
   *  execution; an applied identity is a no-op returning the prior result
   *  (the tripwire counts a violation). The receipt + removal persist
   *  durably; a crash between the executor and the save replays idempotently
   *  (the apply target dedupes by the same portable identity). */
  private async applyProposal(p: QueuedProposal): Promise<unknown> {
    const key = identityKeyOf(p.identity);
    const inFlight = this.inFlight.get(key);
    if (inFlight !== undefined) return inFlight; // ONE execution per identity
    const receipt = this.fileValue!.applied.find((r) => r.identityKey === key);
    if (receipt !== undefined) {
      this.duplicateApplies++; // tripwire: enqueue dedupe should have caught this
      return receipt.result;
    }
    const exec = (async () => {
      const raw = await this.executor.apply(p);
      const result = clone(raw === undefined ? null : raw);
      this.fileValue!.applied.push({ identityKey: key, result, at: this.nowIso() });
      this.fileValue!.proposals = this.fileValue!.proposals.filter((q) => q.id !== p.id);
      this.save();
      return result;
    })();
    this.inFlight.set(key, exec);
    try {
      return await exec;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** The bounded retry: a backoff timer on the injectable clock (the
   *  F-harness FakeClock — zero wall-clock) re-drains. Bounded by the
   *  budget: after maxRetries attempts no further timers are armed; the
   *  entry stays blocked-degraded, surfaced. */
  private scheduleRetry(p: QueuedProposal): void {
    if (p.attempts >= this.configValue.maxRetries) return;
    const delay = Math.min(
      this.configValue.retryBaseDelayMs * 2 ** (p.attempts - 1),
      this.configValue.retryMaxDelayMs,
    );
    this.clockValue.setTimeout(() => {
      this.drain().then(
        () => undefined,
        (err: unknown) => {
          // a background retry drain never escapes as an unhandled
          // rejection — the next verify-entry drain re-surfaces it loudly
          this.lastDrainError = err instanceof Error ? err : new Error(String(err));
        },
      );
    }, delay);
  }
}

// ── the composition hooks (handed to the engine — the queue owns the
// implementations, the engine owns the firing points) ─────────────────────────

/** The engine's verify-entry drain hook (D2): the queue drains fully BEFORE
 *  the mode machine's verify begins — a throwing drain leaves the
 *  transition STAGED (the engine's pinned behavior). */
export function queueDrainHook(queue: ProposalQueue): (ctx: VerifyContext) => Promise<void> {
  return async (_ctx: VerifyContext) => {
    await queue.drain();
  };
}

/** The engine's commit-window hold hook (the sanctioned additive engine
 *  seam): "open" holds the queue's applies; "closed" runs the release
 *  drain. The two machines never interleave. */
export function queueHoldHook(
  queue: ProposalQueue,
): (phase: "open" | "closed", reason: string) => void {
  return (phase: "open" | "closed", reason: string) => {
    if (phase === "open") queue.hold(reason);
    else void queue.release(reason);
  };
}

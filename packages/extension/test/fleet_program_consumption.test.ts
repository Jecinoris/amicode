// #1131 — the fleet program's consumption (the amicissimo#418 companion):
// the staged overlay program (fleet_overlay/overlays/fleet-program.json) is
// the TUNED VALUES for the mode-machine family's injectable knobs —
// #1070's classifier tuning, #1072's verify budget + pending cap, #1092's
// queue retries. The base ships base defaults; this module composes the
// staged values into the EXISTING injectable surfaces when the entitlement
// stages the program, and never touches anything when it doesn't.
//
// THE FIXTURE is a byte-shape copy of the contract owner's LANDED manifest —
// amicissimo#418, the fleet_overlay/overlays/fleet-program.json staged by
// worktree amicissimo-418-fleet-program (branch 418-fleet-program, the
// freeze validator fleet_overlay/program.py + freeze.py define the lawful
// shape). Shape, surface ids, knob names, composes stamps, and tuned values
// are the owner's verbatim — nothing sanitized; the `_comment` header is
// carried verbatim too. Tests mutate DEEP CLONES of it.
//
// The invariants under test (the issue's ACs — shape-adapted, semantics
// unchanged):
//   · Entitled + staged → every knob receives the program's value, not the
//     base default — proven through the REAL constructors, not just the
//     composed config object. (Two knobs are carried over at the base's
//     value by the owner's own tuning — recovery and the window sample
//     count; the program only retunes what the WAN argues for.)
//   · Unentitled / program absent → the composed config equals the base
//     defaults EXACTLY — byte-identical behavior, the solo floor untouched.
//   · The ADR-0003 skew rule, client-side: an older-stamped program
//     revalidates field-by-field against the CURRENT base's knob contract
//     (and composes with the skew named) — or is skipped with the recorded
//     per-field reasons. Never silently merged stale.
//   · An unknown field is rejected loudly (the freeze validator's mirror):
//     top-level, surface, knob, or descriptor key — the base never silently
//     ignores a value it doesn't understand.
//   · The provenance cross-checks (the landed shape's new legs): a wrong
//     `composes` pointer is REJECTED naming both refs; a `base_default`
//     that disagrees with the installed base's constant is SURFACED as
//     named drift — never silently accepted.
//   · Provenance renders: the program's stamps surface on the fleet status
//     detail — the cockpit says where its tuning came from.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveFleetProgram,
  composeFleetConfigs,
  FLEET_PROGRAM_MANIFEST_REL,
  type FleetProgramReceipt,
} from "../src/amicode_service/fleet_program";
import {
  DEFAULT_TRANSPORT_CLASSIFIER_CONFIG,
  TransportClassifier,
} from "../src/amicode_service/transport_classifier";
import {
  DEFAULT_MODE_TRANSITION_CONFIG,
  VERIFY_BUDGET_FLOOR_MS,
  ModeTransitionEngine,
} from "../src/amicode_service/attach_state";
import {
  DEFAULT_PROPOSAL_QUEUE_CONFIG,
  ProposalQueue,
  ProposalStore,
} from "../src/amicode_service/proposal_queue";
import { ModeMachine } from "../src/amicode_service/attach_state";
import { createAmicodeService } from "../src/amicode_service";
import { FakeClock } from "./fixtures/fleet_fault_harness/test_clock";

// ── the program-manifest fixture: a byte-shape copy of the contract owner's
//    LANDED manifest (amicissimo#418, worktree amicissimo-418-fleet-program,
//    fleet_overlay/overlays/fleet-program.json — surface ids, knob names,
//    composes stamps, and tuned values verbatim). ──────────────────────────

/** The fixture manifest, exactly as the contract owner landed it. */
const REAL_MANIFEST = {
  _comment:
    "The fleet program (amicissimo#418, fleet rearchitect P4b; ADR-0004 decision 3 + the R1 conform ruling): " +
    "the TUNED thresholds/budgets as staged overlay data, composing the base machinery's INJECTABLE knobs " +
    "— transport_classifier.ts's #1070 classifier tuning, attach_state.ts's #1072 engine budgets, " +
    "proposal_queue.ts's #1092 queue retries — never hard-coded in the base. INTERNAL CONSISTENCY, documented: " +
    "the program's verify budget (90s) sits ABOVE the base's 60s patience floor (attach_state.ts " +
    "VERIFY_BUDGET_FLOOR_MS = 60000) — the base clamps below-floor values UP, so the program never fights the " +
    "floor; its budget is documented above it, and the freeze validator rejects a program value at-or-below the " +
    "floor (fleet_overlay.program, kind 'consistency'). Provenance per ADR-0003 decision 7: every field stamps " +
    "the base knob it composes ('composes', module:interface.knob — the names mirror the amicode option " +
    "surfaces exactly) and the base version it was tuned against ('base_version'); a program stamped against " +
    "an older base is re-validated field-by-field against the knob registry at staging and the merge record " +
    "carries the skew note. Every field is additive-optional: 'base_default' mirrors the base's shipped default " +
    "(what an unentitled install runs — the base reader always has a value to fall back to), 'value' is the " +
    "fleet-tuned value the entitled install composes. The surfaces are NEW fleet-class surfaces ('multi-device " +
    "policy'); without the entitlement the program never stages and the base defaults run alone. Tuning " +
    "rationale: the fleet tunnel is a WAN path — sustained-fault windows and retry budgets get more patience " +
    "than the base's localhost-calibrated defaults, the latency threshold gains RTT headroom, and the " +
    "escalation cap (base placeholder 300s, the spec names no value) names 'structurally down, not merely " +
    "idle' at 15 minutes. Design of record: spec spec-20260913-114814 §3 + ADR-0004 d3 + ADR-0003 d7; consumed " +
    "by the amicode extension's compose step (validate_program, then the existing dispatch).",
  overlay_id: "fleet-program",
  overlay_version: 1,
  base_version: "v1.18.29",
  surfaces: [
    {
      surface_id: "transport-classifier-tuning",
      fleet_class: "multi-device policy",
      fields: [
        {
          name: "hubDownConsecutiveNoResponses",
          base_default: 3,
          value: 5,
          composes: "transport_classifier.ts:TransportClassifierConfig.hubDownConsecutiveNoResponses",
          base_version: "v1.18.29",
          description:
            "N consecutive no-responses entering hub-down. Tuned 5 (base 3): over the fleet WAN tunnel " +
            "transient refusals cluster — the longer sustained window keeps a hub-up-but-lossy link from " +
            "flapping into the hub-down posture.",
        },
        {
          name: "recoveryConsecutiveHealthy",
          base_default: 3,
          value: 3,
          composes: "transport_classifier.ts:TransportClassifierConfig.recoveryConsecutiveHealthy",
          base_version: "v1.18.29",
          description:
            "Consecutive healthy outcomes re-entering ok. Carried over at the base's 3 — recovery should " +
            "stay quick; the D6 hysteresis is the right shape, the fleet program only retunes what the WAN " +
            "argues for.",
        },
        {
          name: "degradedLatencyP95Ms",
          base_default: 2000,
          value: 2500,
          composes: "transport_classifier.ts:TransportClassifierConfig.degradedLatencyP95Ms",
          base_version: "v1.18.29",
          description:
            "The p95 latency threshold (ms) for degraded entry (hub-up-but-slow). Tuned 2500 (base 2000, " +
            "localhost-calibrated): RTT headroom for the tunnel, so a healthy-but-remote hub is not " +
            "badge-degraded by distance alone.",
        },
        {
          name: "degradedWindowSamples",
          base_default: 5,
          value: 5,
          composes: "transport_classifier.ts:TransportClassifierConfig.degradedWindowSamples",
          base_version: "v1.18.29",
          description:
            "The latency measurement window (samples). Carried over at the base's 5 — a small window with " +
            "nearest-rank p95 is the right granularity at fleet scale; retuning it is the shape skill's " +
            "job, not the program's.",
        },
        {
          name: "escalationCapMs",
          base_default: 300000,
          value: 900000,
          composes: "transport_classifier.ts:TransportClassifierConfig.escalationCapMs",
          base_version: "v1.18.29",
          description:
            "The escalation cap (ms): transient faults persisting while time-since-last-successful-fetch " +
            "exceeds it emit ONE presumed-structural EVENT (never auto-applied). Tuned 900000 — 15 minutes " +
            "(base default 300000 is the documented PLACEHOLDER: the spec names no value). Rationale: the " +
            "fleet's scheduled maintenance windows run longer than 5 minutes; 15 names 'structurally down, " +
            "not merely idle' without crying wolf during a known sweep.",
        },
      ],
    },
    {
      surface_id: "mode-transition-budgets",
      fleet_class: "multi-device policy",
      fields: [
        {
          name: "verifyBudgetMs",
          base_default: 60000,
          value: 90000,
          composes: "attach_state.ts:ModeTransitionConfig.verifyBudgetMs",
          base_version: "v1.18.29",
          description:
            "The attach-test budget (ms), CLAMPED UP to the base's 60s floor (VERIFY_BUDGET_FLOOR_MS) — " +
            "the program's 90s sits ABOVE the floor by construction: the base clamps below-floor values " +
            "and the program never fights the floor. Tuned 90s: mode transitions verify across the " +
            "tunnel, and the #1034 patience floor is the local case, not the fleet case.",
        },
        {
          name: "pendingCapMs",
          base_default: 300000,
          value: 600000,
          composes: "attach_state.ts:ModeTransitionConfig.pendingCapMs",
          base_version: "v1.18.29",
          description:
            "How long commit-pending may persist before the abort/resume choice surfaces (ms). Tuned " +
            "600000 — 10 minutes (base 5): a commit in flight over the tunnel gets the headroom before a " +
            "human is asked to arbitrate; the journal record makes the wait honest, never torn.",
        },
      ],
    },
    {
      surface_id: "proposal-queue-tuning",
      fleet_class: "multi-device policy",
      fields: [
        {
          name: "maxRetries",
          base_default: 3,
          value: 5,
          composes: "proposal_queue.ts:ProposalQueueConfig.maxRetries",
          base_version: "v1.18.29",
          description:
            "The bounded retry budget: total truth-fetch attempts per blocked proposal. Tuned 5 (base 3): " +
            "the offline proposal's re-verify gets the extra attempts the flapping tunnel argues for — " +
            "the budget stays bounded, and exhausted proposals surface named, never wedged.",
        },
        {
          name: "retryBaseDelayMs",
          base_default: 1000,
          value: 2000,
          composes: "proposal_queue.ts:ProposalQueueConfig.retryBaseDelayMs",
          base_version: "v1.18.29",
          description:
            "The first retry's backoff delay (ms); each further failure doubles it. Tuned 2000 (base " +
            "1000): let the tunnel settle before the first re-fetch — the base's 1s is a localhost " +
            "instinct.",
        },
        {
          name: "retryMaxDelayMs",
          base_default: 30000,
          value: 60000,
          composes: "proposal_queue.ts:ProposalQueueConfig.retryMaxDelayMs",
          base_version: "v1.18.29",
          description:
            "The backoff cap (ms). Tuned 60000 (base 30000): with 5 attempts, doubling from 2s reaches " +
            "the cap on the 5th — the queue stays patient across a maintenance window without hammering " +
            "the tunnel.",
        },
      ],
    },
  ],
};

/** The fixture program's tuned values, keyed by composed section — the
 *  owner's own tuning, verbatim. recoveryConsecutiveHealthy and
 *  degradedWindowSamples are CARRIED OVER at the base's value (the program
 *  only retunes what the WAN argues for); the rest differ from base. */
const PROGRAM_TUNING = {
  classifier: {
    hubDownConsecutiveNoResponses: 5, // base 3
    recoveryConsecutiveHealthy: 3, // carried over at the base's 3
    degradedLatencyP95Ms: 2500, // base 2000
    degradedWindowSamples: 5, // carried over at the base's 5
    escalationCapMs: 900_000, // base placeholder 300_000
  },
  engine: {
    verifyBudgetMs: 90_000, // base 60s floor
    pendingCapMs: 600_000, // base 5m
  },
  queue: {
    maxRetries: 5, // base 3
    retryBaseDelayMs: 2_000, // base 1s
    retryMaxDelayMs: 60_000, // base 30s
  },
};

const VENDORED_BASE = "v1.18.29";

/** Deep-clone helper (the fixture is mutated per test, never shared). */
function cloneManifest(): typeof REAL_MANIFEST {
  return JSON.parse(JSON.stringify(REAL_MANIFEST)) as typeof REAL_MANIFEST;
}

/** Find one field descriptor by surface + knob name (for targeted mutations). */
function fieldOf(
  manifest: typeof REAL_MANIFEST,
  surfaceId: string,
  knob: string,
): Record<string, unknown> {
  const surface = manifest.surfaces.find((s) => s.surface_id === surfaceId);
  if (!surface) throw new Error(`fixture surface missing: ${surfaceId}`);
  const field = surface.fields.find((f) => f.name === knob);
  if (!field) throw new Error(`fixture field missing: ${surfaceId}.${knob}`);
  return field as unknown as Record<string, unknown>;
}

function writeProgramManifest(
  sourceRoot: string,
  manifest: unknown,
): string {
  const dir = join(sourceRoot, "fleet_overlay", "overlays");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, FLEET_PROGRAM_MANIFEST_REL.split(/[\\/]/).pop()!);
  writeFileSync(p, JSON.stringify(manifest));
  return p;
}

function freshSource(): string {
  const root = mkdtempSync(join(tmpdir(), "amicode-1131-program-"));
  sources.push(root);
  return root;
}

const sources: string[] = [];
afterEach(() => {
  while (sources.length) {
    const s = sources.pop()!;
    try {
      rmSync(s, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
});

const ENTITLED = ["amicissimo"];
const UNENTITLED: string[] = [];

/** Shared assertion: the fixture manifest composes all ten knobs with the
 *  owner's tuned values, no skew, no drift. */
function expectCleanComposition(receipt: FleetProgramReceipt): void {
  expect(receipt.entitlement).toBe("present");
  expect(receipt.composed).toBe(true);
  expect(receipt.revalidated_fields).toBe(10);
  expect(receipt.skew).toBeUndefined();
  expect(receipt.drift).toBeUndefined();
  expect(receipt.composed_fields?.length).toBe(10);
  for (const f of receipt.composed_fields ?? []) {
    expect(f).toHaveProperty("base_default");
    expect(f).toHaveProperty("value");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// AC 1 — entitled + staged: every knob receives the program's value
// ══════════════════════════════════════════════════════════════════════════════

describe("#1131 the staged program composes every knob (entitled)", () => {
  it("each knob receives the program's value (all ten — the owner's tuning, verbatim)", () => {
    const src = freshSource();
    writeProgramManifest(src, cloneManifest());
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expectCleanComposition(result.receipt);
    const composed = composeFleetConfigs(result.values);
    // the classifier knobs (#1070) — including the two carried-over knobs,
    // which equal base BY THE OWNER'S CHOICE, not by defaulting
    expect(composed.classifier).toEqual(PROGRAM_TUNING.classifier);
    // the engine budgets (#1072)
    expect(composed.engine).toEqual(PROGRAM_TUNING.engine);
    // the queue retries (#1092)
    expect(composed.queue).toEqual(PROGRAM_TUNING.queue);
    // provenance: composed_fields records every knob with the INSTALLED base
    // default it replaces — the merge record, never a merged field (ADR-0003 d7)
    for (const f of result.receipt.composed_fields ?? []) {
      const [section, knob] = f.path.startsWith("surfaces.transport-classifier-tuning.")
        ? ["classifier", f.path.split(".")[2]]
        : f.path.startsWith("surfaces.mode-transition-budgets.")
          ? ["engine", f.path.split(".")[2]]
          : ["queue", f.path.split(".")[2]];
      const tuned = (PROGRAM_TUNING as Record<string, Record<string, number>>)[section]![knob];
      expect(f.value).toBe(tuned);
    }
  });

  it("the composed values feed the REAL injectable knobs — classifier behavior tuned", () => {
    const src = freshSource();
    writeProgramManifest(src, cloneManifest());
    const { values } = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    const { classifier } = composeFleetConfigs(values);
    const machine = new ModeMachine();
    const tc = new TransportClassifier({ machine, config: classifier });
    // base N=3 flips hub-down at the THIRD no-response; the program's N=5
    // must hold degraded through the fourth and flip only at the fifth
    tc.record({ kind: "no-response", fault: "timeout" });
    tc.record({ kind: "no-response", fault: "timeout" });
    tc.record({ kind: "no-response", fault: "timeout" });
    expect(machine.read().posture).toBe("degraded"); // the BASE would be hub-down here
    tc.record({ kind: "no-response", fault: "timeout" });
    expect(machine.read().posture).toBe("degraded"); // the program's N=5: still not
    tc.record({ kind: "no-response", fault: "timeout" });
    expect(machine.read().posture).toBe("hub-down"); // the FIFTH consecutive
  });

  it("the composed values feed the REAL injectable knobs — engine budgets + the floor relationship", () => {
    const src = freshSource();
    writeProgramManifest(src, cloneManifest());
    const { values } = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    const { engine } = composeFleetConfigs(values);
    const engineClock = new FakeClock();
    const machine = new ModeMachine();
    const verify = () => ({ kind: "pass" as const });
    const eng = new ModeTransitionEngine({ machine, verify, clock: engineClock, config: engine });
    const cfg = eng.config();
    expect(cfg.verifyBudgetMs).toBe(90_000); // the program's, above the floor
    expect(cfg.pendingCapMs).toBe(600_000); // 10m — the program's
    // the program never fights the floor: a below-floor program value is
    // clamped UP by the base (the engine's own rule, composed or not)
    const eng2 = new ModeTransitionEngine({
      machine,
      verify,
      clock: engineClock,
      config: { ...engine, verifyBudgetMs: 1_000 },
    });
    expect(eng2.config().verifyBudgetMs).toBe(VERIFY_BUDGET_FLOOR_MS);
  });

  it("the composed values feed the REAL injectable knobs — the queue's bounded retry", async () => {
    const src = freshSource();
    writeProgramManifest(src, cloneManifest());
    const { values } = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    const { queue } = composeFleetConfigs(values);
    const root = mkdtempSync(join(tmpdir(), "amicode-1131-queue-"));
    sources.push(root);
    const clock = new FakeClock();
    const machine = new ModeMachine();
    const store = new ProposalStore({ path: join(root, "proposal-queue.json") });
    const q = new ProposalQueue({
      machine,
      store,
      executor: { apply: () => undefined },
      fetchTruth: () => {
        throw new Error("fetch died: the tunnel is down");
      },
      clock,
      config: queue,
    });
    q.enqueue({
      type: "structural-surface",
      payload: { class: "presumed-structural" },
      precondition: { claim: "structural:presumed-structural", expected: { class: "presumed-structural" } },
      confirmStamp: new Date(clock.now()).toISOString(),
    });
    await q.drain(); // attempt 1 fails → the retry timer at the program's base backoff
    // base retryBaseDelayMs is 1000; the program's is 2000 — the timer must
    // carry the PROGRAM's value
    expect(clock.pending()).toBe(PROGRAM_TUNING.queue.retryBaseDelayMs);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC 2 — unentitled / program absent: base defaults, byte-identical
// ══════════════════════════════════════════════════════════════════════════════

describe("#1131 unentitled / program absent — the base defaults, exactly", () => {
  it("unentitled: the composed config equals the base defaults EXACTLY — even with the program on disk", () => {
    const src = freshSource();
    writeProgramManifest(src, cloneManifest()); // present, but never read
    const result = resolveFleetProgram({ entitlements: UNENTITLED, overlaySource: src });
    expect(result.composed).toBe(false);
    expect(result.receipt.entitlement).toBe("absent");
    const composed = composeFleetConfigs(result.values);
    expect(composed.classifier).toEqual(DEFAULT_TRANSPORT_CLASSIFIER_CONFIG);
    expect(composed.engine).toEqual(DEFAULT_MODE_TRANSITION_CONFIG);
    expect(composed.queue).toEqual(DEFAULT_PROPOSAL_QUEUE_CONFIG);
  });

  it("unentitled: the overlay source is never even READ (the resolver's own rule)", () => {
    const result = resolveFleetProgram({
      entitlements: UNENTITLED,
      overlaySource: "/proc/amicode-1131-must-not-read-this",
    });
    expect(result.composed).toBe(false);
    expect(result.receipt.entitlement).toBe("absent");
  });

  it("entitled but the program manifest absent: base defaults + the named absence", () => {
    const src = freshSource(); // no manifest written
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expect(result.composed).toBe(false);
    expect(result.receipt.absence_reason).toBe("manifest-absent");
    const composed = composeFleetConfigs(result.values);
    expect(composed.classifier).toEqual(DEFAULT_TRANSPORT_CLASSIFIER_CONFIG);
    expect(composed.engine).toEqual(DEFAULT_MODE_TRANSITION_CONFIG);
    expect(composed.queue).toEqual(DEFAULT_PROPOSAL_QUEUE_CONFIG);
  });

  it("composeFleetConfigs({}) IS the base defaults — the composition's identity element", () => {
    const composed = composeFleetConfigs({});
    expect(composed.classifier).toEqual(DEFAULT_TRANSPORT_CLASSIFIER_CONFIG);
    expect(composed.engine).toEqual(DEFAULT_MODE_TRANSITION_CONFIG);
    expect(composed.queue).toEqual(DEFAULT_PROPOSAL_QUEUE_CONFIG);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC 3 — the skew rule, client-side
// ══════════════════════════════════════════════════════════════════════════════

describe("#1131 the ADR-0003 skew rule (client-side)", () => {
  it("an older-stamped program revalidates field-by-field and composes — with the skew named", () => {
    const src = freshSource();
    const manifest = cloneManifest();
    manifest.base_version = "v1.18.28"; // the per-field stamps stay — documentation
    writeProgramManifest(src, manifest);
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    // every field revalidated against the CURRENT base's knob contract and
    // it all held → compose, with the skew named in the receipt
    expect(result.composed).toBe(true);
    expect(result.receipt.skew).toBeDefined();
    expect(result.receipt.skew).toContain("v1.18.28");
    expect(result.receipt.revalidated_fields).toBe(10);
    const composed = composeFleetConfigs(result.values);
    expect(composed.classifier).toEqual(PROGRAM_TUNING.classifier);
  });

  it("a stale program whose fields no longer revalidate is SKIPPED with the recorded per-field reasons — never silently merged", () => {
    const src = freshSource();
    // a knob retired from the base's contract (an older base's field the
    // current base no longer has) + one that still revalidates; the
    // program stamps the OLDER base on its envelope (the skew) and the
    // stale field carries its own older stamp (documentation)
    const manifest = cloneManifest();
    manifest.base_version = "v1.18.27";
    (manifest.surfaces[0].fields as unknown[]).push({
      name: "hubDownConsecutiveNoResponsesLegacy",
      base_default: 7,
      value: 7,
      composes: "transport_classifier.ts:TransportClassifierConfig.hubDownConsecutiveNoResponsesLegacy",
      base_version: "v1.18.27",
      description: "an older base's field the current base no longer documents",
    });
    (manifest.surfaces[0].fields.find((f) => f.name === "hubDownConsecutiveNoResponses") as Record<string, unknown>).base_version = "v1.18.27";
    writeProgramManifest(src, manifest);
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expect(result.composed).toBe(false);
    expect(result.receipt.skew).toBeDefined();
    const reasons = result.receipt.rejections.map((r) => r.path);
    expect(reasons.some((p) => p.includes("hubDownConsecutiveNoResponsesLegacy"))).toBe(true);
    // nothing composed — not even the field that WOULD have revalidated
    expect(result.values.classifier).toBeUndefined();
    const composed = composeFleetConfigs(result.values);
    expect(composed.classifier).toEqual(DEFAULT_TRANSPORT_CLASSIFIER_CONFIG);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC 4 — unknown fields rejected loudly (the freeze validator's mirror)
// ══════════════════════════════════════════════════════════════════════════════

describe("#1131 unknown fields are rejected loudly", () => {
  it("an unknown knob on a known surface is rejected — naming the field — and nothing composes", () => {
    const src = freshSource();
    const manifest = cloneManifest();
    (manifest.surfaces[0].fields as unknown[]).push({
      name: "hubDownConsecutiveNonsense",
      base_default: 9,
      value: 9,
      composes: "transport_classifier.ts:TransportClassifierConfig.hubDownConsecutiveNonsense",
      base_version: "v1.18.29",
      description: "not a documented base knob",
    });
    writeProgramManifest(src, manifest);
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expect(result.composed).toBe(false);
    const reasons = result.receipt.rejections.map((r) => r.reason).join(" ");
    expect(reasons).toContain("hubDownConsecutiveNonsense");
    expect(composeFleetConfigs(result.values).classifier).toEqual(DEFAULT_TRANSPORT_CLASSIFIER_CONFIG);
  });

  it("an unknown program surface is rejected loudly — the lawful surface set is the owner's", () => {
    const src = freshSource();
    const manifest = cloneManifest();
    (manifest.surfaces as unknown[]).push({
      surface_id: "queue-nonsense-tuning",
      fleet_class: "multi-device policy",
      fields: [],
    });
    writeProgramManifest(src, manifest);
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expect(result.composed).toBe(false);
    const reasons = result.receipt.rejections.map((r) => r.reason).join(" ");
    expect(reasons).toContain("queue-nonsense-tuning");
    expect(reasons).toContain("unknown program surface");
    expect(result.receipt.absence_reason).toBe("program-invalid");
  });

  it("an unknown top-level field is rejected loudly", () => {
    const src = freshSource();
    const manifest = cloneManifest() as unknown as Record<string, unknown>;
    manifest.magic_tuning_extra = true;
    writeProgramManifest(src, manifest);
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expect(result.composed).toBe(false);
    const reasons = result.receipt.rejections.map((r) => r.reason).join(" ");
    expect(reasons).toContain("magic_tuning_extra");
  });

  it("an unclassified field-descriptor key is rejected loudly — the ADR-0003 table-driven floor", () => {
    const src = freshSource();
    const manifest = cloneManifest();
    fieldOf(manifest, "proposal-queue-tuning", "maxRetries").required = true;
    writeProgramManifest(src, manifest);
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expect(result.composed).toBe(false);
    const reasons = result.receipt.rejections.map((r) => r.reason).join(" ");
    expect(reasons).toContain("unclassified descriptor key");
    expect(reasons).toContain("required");
  });

  it("a non-numeric or non-positive tuned value is rejected loudly — the knobs are positive numbers", () => {
    for (const bad of ["fast", -5, 0, Number.POSITIVE_INFINITY, null, undefined]) {
      const src = freshSource();
      const manifest = cloneManifest();
      fieldOf(manifest, "proposal-queue-tuning", "retryBaseDelayMs").value = bad as number;
      writeProgramManifest(src, manifest);
      const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
      expect(result.composed).toBe(false);
      expect(result.receipt.absence_reason).toBe("program-invalid");
    }
  });

  it("a broken envelope (missing base_version stamp) is rejected — provenance per ADR-0003 d7 is not optional", () => {
    const src = freshSource();
    const manifest = cloneManifest() as unknown as Record<string, unknown>;
    manifest.base_version = undefined;
    writeProgramManifest(src, manifest);
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expect(result.composed).toBe(false);
    expect(result.receipt.absence_reason).toBe("program-envelope-invalid");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC 4b — the landed shape's provenance cross-checks (new in the shape
// adaptation): the `composes` pointer and the `base_default` claim
// ══════════════════════════════════════════════════════════════════════════════

describe("#1131 the provenance cross-checks (the landed descriptor shape)", () => {
  it("a WRONG composes pointer is rejected — naming both the manifest's claim and the base's documented ref", () => {
    const src = freshSource();
    const manifest = cloneManifest();
    fieldOf(manifest, "proposal-queue-tuning", "maxRetries").composes =
      "attach_state.ts:ModeTransitionConfig.maxRetries"; // a cross-module lie
    writeProgramManifest(src, manifest);
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expect(result.composed).toBe(false);
    const reasons = result.receipt.rejections.map((r) => r.reason).join(" ");
    expect(reasons).toContain("attach_state.ts:ModeTransitionConfig.maxRetries"); // the manifest's claim
    expect(reasons).toContain("proposal_queue.ts:ProposalQueueConfig.maxRetries"); // the base's ref
    expect(result.receipt.absence_reason).toBe("program-invalid");
    const composed = composeFleetConfigs(result.values);
    expect(composed.queue).toEqual(DEFAULT_PROPOSAL_QUEUE_CONFIG);
  });

  it("a field with NO composes stamp is rejected — provenance is not optional (ADR-0003 d7)", () => {
    const src = freshSource();
    const manifest = cloneManifest();
    delete fieldOf(manifest, "proposal-queue-tuning", "maxRetries").composes;
    writeProgramManifest(src, manifest);
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expect(result.composed).toBe(false);
    const reasons = result.receipt.rejections.map((r) => r.reason).join(" ");
    expect(reasons).toContain("no composes stamp");
    expect(reasons).toContain("proposal_queue.ts:ProposalQueueConfig.maxRetries");
  });

  it("a base_default that DISAGREES with the installed base's constant is surfaced as named drift — composition proceeds, the receipt carries both numbers", () => {
    const src = freshSource();
    const manifest = cloneManifest();
    fieldOf(manifest, "proposal-queue-tuning", "maxRetries").base_default = 99; // base ships 3
    writeProgramManifest(src, manifest);
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    // composition is NOT blocked by drift — the tuned value is explicit and
    // validated — but the drift is never silent:
    expect(result.composed).toBe(true);
    expect(result.receipt.drift).toHaveLength(1);
    expect(result.receipt.drift![0].path).toBe("surfaces.proposal-queue-tuning.maxRetries");
    expect(result.receipt.drift![0].manifest_base_default).toBe(99);
    expect(result.receipt.drift![0].installed_base_default).toBe(
      DEFAULT_PROPOSAL_QUEUE_CONFIG.maxRetries,
    );
    // the merge record stamps the INSTALLED constant as the default replaced
    const composedField = result.receipt.composed_fields!.find(
      (f) => f.path === "surfaces.proposal-queue-tuning.maxRetries",
    )!;
    expect(composedField.base_default).toBe(DEFAULT_PROPOSAL_QUEUE_CONFIG.maxRetries);
    expect(composedField.value).toBe(5);
  });

  it("the landed manifest's own base_defaults agree with the installed base — zero drift, no false positives", () => {
    const src = freshSource();
    writeProgramManifest(src, cloneManifest());
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expect(result.composed).toBe(true);
    expect(result.receipt.drift).toBeUndefined();
  });

  it("a field with no base_default at all is rejected — the base reader must always have a fallback", () => {
    const src = freshSource();
    const manifest = cloneManifest();
    delete fieldOf(manifest, "proposal-queue-tuning", "maxRetries").base_default;
    writeProgramManifest(src, manifest);
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expect(result.composed).toBe(false);
    const reasons = result.receipt.rejections.map((r) => r.reason).join(" ");
    expect(reasons).toContain("no base_default");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC 5 — provenance renders on the fleet status detail
// ══════════════════════════════════════════════════════════════════════════════

describe("#1131 provenance renders on the fleet status detail", () => {
  const running: { stop(): Promise<void> }[] = [];
  afterEach(async () => {
    while (running.length) await running.pop()!.stop();
  });

  function writeDataPlaneManifest(src: string): void {
    writeFileSync(
      join(src, "fleet_overlay", "overlays", "fleet-data-plane.json"),
      JSON.stringify({
        overlay_id: "fleet-data-plane",
        overlay_version: 1,
        base_version: VENDORED_BASE,
        surfaces: [
          {
            surface_id: "data-plane-routing",
            fleet_class: "data-plane routing",
            fields: [{ name: "upstream_mode", base_default: "engine", description: "the routing mode" }],
          },
        ],
      }),
    );
  }

  async function bootFleetService(src: string, entitlements: string[]) {
    const service = createAmicodeService({
      fleet: {
        entitlements,
        overlaySource: src,
        hub: { getUrl: () => "http://127.0.0.1:9" },
      },
    });
    const url = await service.start();
    running.push(service);
    const res = await fetch(new URL("/amicode/fleet/status", url), {
      headers: { Authorization: service.authHeader },
    });
    expect(res.status).toBe(200);
    return JSON.parse(await res.text());
  }

  it("the staged program's stamps surface in the fleet status detail", async () => {
    const src = freshSource();
    writeProgramManifest(src, cloneManifest());
    // the status route lives behind the data-plane staging, so the fixture
    // source carries the shipped data-plane manifest too
    writeDataPlaneManifest(src);
    const body = await bootFleetService(src, ENTITLED);
    expect(body.program).toBeDefined();
    expect(body.program.overlay_id).toBe("fleet-program");
    expect(body.program.program_base_version).toBe(VENDORED_BASE);
    expect(body.program.composed).toBe(true);
    expect(body.program.composed_fields?.length).toBe(10);
  });

  it("an unentitled boot never renders program provenance — the route itself is absent (zero fleet surfaces)", async () => {
    const src = freshSource();
    writeProgramManifest(src, cloneManifest());
    writeDataPlaneManifest(src);
    const service = createAmicodeService({
      fleet: {
        entitlements: UNENTITLED,
        overlaySource: src,
        hub: { getUrl: () => "http://127.0.0.1:9" },
      },
    });
    running.push(service);
    const url = await service.start();
    const res = await fetch(new URL("/amicode/fleet/status", url), {
      headers: { Authorization: service.authHeader },
    });
    // the H3 rule: no entitlement → the fleet surfaces DO NOT EXIST — the
    // status route answers the base no-route 404, so nothing (program
    // provenance included) renders at all
    expect(res.status).toBe(404);
  });
});

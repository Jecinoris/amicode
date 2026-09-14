// #1131 — the fleet program's consumption (the amicissimo#418 companion):
// the staged overlay program (fleet_overlay/overlays/fleet-program.json) is
// the TUNED VALUES for the mode-machine family's injectable knobs —
// #1070's classifier tuning, #1072's verify budget + pending cap, #1092's
// queue retries. The base ships base defaults; this module composes the
// staged values into the EXISTING injectable surfaces when the entitlement
// stages the program, and never touches anything when it doesn't.
//
// The invariants under test (the issue's ACs):
//   · Entitled + staged → every knob receives the program's value, not the
//     base default — proven through the REAL constructors, not just the
//     composed config object.
//   · Unentitled / program absent → the composed config equals the base
//     defaults EXACTLY — byte-identical behavior, the solo floor untouched.
//   · The ADR-0003 skew rule, client-side: an older-stamped program
//     revalidates field-by-field against the CURRENT base's knob contract
//     (and composes with the skew named) — or is skipped with the recorded
//     per-field reasons. Never silently merged stale.
//   · An unknown field is rejected loudly (the freeze validator's mirror):
//     the base never silently ignores a value it doesn't understand.
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

// ── the program-manifest fixture (modeled on amicissimo#418's documented
//    shape — the same envelope as the shipped data-plane manifest, with the
//    tuned program as three sections mirroring the base option surfaces
//    EXACTLY: TransportClassifierConfig / ModeTransitionConfig /
//    ProposalQueueConfig knob-for-knob) ─────────────────────────────────────

/** The tuned values the fixture program carries — every one deliberately
 *  DIFFERENT from the base default so "the program's value, not the base
 *  default" is assertable knob by knob. */
const PROGRAM_TUNING = {
  classifier: {
    hubDownConsecutiveNoResponses:
      DEFAULT_TRANSPORT_CLASSIFIER_CONFIG.hubDownConsecutiveNoResponses + 2, // 3 → 5
    recoveryConsecutiveHealthy:
      DEFAULT_TRANSPORT_CLASSIFIER_CONFIG.recoveryConsecutiveHealthy + 3, // 2 → 5
    degradedLatencyP95Ms: DEFAULT_TRANSPORT_CLASSIFIER_CONFIG.degradedLatencyP95Ms + 500,
    degradedWindowSamples: DEFAULT_TRANSPORT_CLASSIFIER_CONFIG.degradedWindowSamples + 4,
    escalationCapMs: DEFAULT_TRANSPORT_CLASSIFIER_CONFIG.escalationCapMs + 120_000,
  },
  engine: {
    verifyBudgetMs: DEFAULT_MODE_TRANSITION_CONFIG.verifyBudgetMs + 30_000, // 60s → 90s
    pendingCapMs: DEFAULT_MODE_TRANSITION_CONFIG.pendingCapMs + 300_000, // 5m → 10m
  },
  queue: {
    maxRetries: DEFAULT_PROPOSAL_QUEUE_CONFIG.maxRetries + 2, // 3 → 5
    retryBaseDelayMs: DEFAULT_PROPOSAL_QUEUE_CONFIG.retryBaseDelayMs + 1_000, // 1s → 2s
    retryMaxDelayMs: DEFAULT_PROPOSAL_QUEUE_CONFIG.retryMaxDelayMs + 30_000, // 30s → 60s
  },
};

const VENDORED_BASE = "v1.18.29";

function writeProgramManifest(
  sourceRoot: string,
  program: unknown,
  opts: { baseVersion?: string; envelope?: Record<string, unknown>; raw?: string } = {},
): string {
  const dir = join(sourceRoot, "fleet_overlay", "overlays");
  mkdirSync(dir, { recursive: true });
  const body =
    opts.raw ??
    JSON.stringify({
      _comment:
        "The fleet program (amicissimo#418): tuned thresholds/budgets composing the base " +
        "machinery's injectable knobs. The base clamps verify budgets UP to its 60s floor — " +
        "the program never fights the floor.",
      overlay_id: "fleet-program",
      overlay_version: 1,
      base_version: opts.baseVersion ?? VENDORED_BASE,
      program,
      ...(opts.envelope ?? {}),
    });
  const p = join(dir, FLEET_PROGRAM_MANIFEST_REL.split(/[\\/]/).pop()!);
  writeFileSync(p, body);
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

// ══════════════════════════════════════════════════════════════════════════════
// AC 1 — entitled + staged: every knob receives the program's value
// ══════════════════════════════════════════════════════════════════════════════

describe("#1131 the staged program composes every knob (entitled)", () => {
  it("each knob receives the program's value, not the base default (all ten)", () => {
    const src = freshSource();
    writeProgramManifest(src, PROGRAM_TUNING);
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expect(result.receipt.entitlement).toBe("present");
    expect(result.composed).toBe(true);
    const composed = composeFleetConfigs(result.values);
    // the classifier knobs (#1070)
    expect(composed.classifier).toMatchObject(PROGRAM_TUNING.classifier);
    // the engine budgets (#1072)
    expect(composed.engine).toMatchObject(PROGRAM_TUNING.engine);
    // the queue retries (#1092)
    expect(composed.queue).toMatchObject(PROGRAM_TUNING.queue);
    // provenance: composed_fields records every knob with the base default
    // it replaced — the merge record, never a merged field (ADR-0003 d7)
    expect(result.receipt.composed_fields?.length).toBe(10);
    for (const f of result.receipt.composed_fields ?? []) {
      expect(f).toHaveProperty("base_default");
 expect(f).toHaveProperty("value");
    }
  });

  it("the composed values feed the REAL injectable knobs — classifier behavior tuned", () => {
    const src = freshSource();
    writeProgramManifest(src, PROGRAM_TUNING);
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
    writeProgramManifest(src, PROGRAM_TUNING);
    const { values } = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    const { engine } = composeFleetConfigs(values);
    const engineClock = new FakeClock();
    const machine = new ModeMachine();
    const verify = () => ({ kind: "pass" as const });
    const eng = new ModeTransitionEngine({ machine, verify, clock: engineClock, config: engine });
    const cfg = eng.config();
    expect(cfg.verifyBudgetMs).toBe(DEFAULT_MODE_TRANSITION_CONFIG.verifyBudgetMs + 30_000); // 90s — the program's, above the floor
    expect(cfg.pendingCapMs).toBe(DEFAULT_MODE_TRANSITION_CONFIG.pendingCapMs + 300_000); // 10m — the program's
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
    writeProgramManifest(src, PROGRAM_TUNING);
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
    writeProgramManifest(src, PROGRAM_TUNING); // present, but never read
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
    writeProgramManifest(src, PROGRAM_TUNING, { baseVersion: "v1.18.28" });
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    // every field revalidated against the CURRENT base's knob contract and
    // it all held → compose, with the skew named in the receipt
    expect(result.composed).toBe(true);
    expect(result.receipt.skew).toBeDefined();
    expect(result.receipt.skew).toContain("v1.18.28");
    expect(result.receipt.revalidated_fields).toBe(10);
    const composed = composeFleetConfigs(result.values);
    expect(composed.classifier).toMatchObject(PROGRAM_TUNING.classifier);
  });

  it("a stale program whose fields no longer revalidate is SKIPPED with the recorded per-field reasons — never silently merged", () => {
    const src = freshSource();
    // a knob retired from the base's contract (an older base's field the
    // current base no longer has) + one that still revalidates
    writeProgramManifest(
      src,
      {
        classifier: {
          ...PROGRAM_TUNING.classifier,
          hubDownConsecutiveNoResponsesLegacy: 7,
        },
      },
      { baseVersion: "v1.18.27" },
    );
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
  it("an unknown knob inside a known section is rejected — naming the field — and nothing composes", () => {
    const src = freshSource();
    writeProgramManifest(src, {
      classifier: {
        ...PROGRAM_TUNING.classifier,
        hubDownConsecutiveNonsense: 9,
      },
    });
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expect(result.composed).toBe(false);
    const reasons = result.receipt.rejections.map((r) => r.reason).join(" ");
    expect(reasons).toContain("hubDownConsecutiveNonsense");
    expect(composeFleetConfigs(result.values).classifier).toEqual(DEFAULT_TRANSPORT_CLASSIFIER_CONFIG);
  });

  it("an unknown top-level field is rejected loudly", () => {
    const src = freshSource();
    writeProgramManifest(src, PROGRAM_TUNING, {
      envelope: { magic_tuning_extra: true },
    });
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expect(result.composed).toBe(false);
    const reasons = result.receipt.rejections.map((r) => r.reason).join(" ");
    expect(reasons).toContain("magic_tuning_extra");
  });

  it("a non-numeric or non-positive value is rejected loudly — the knobs are positive numbers", () => {
    for (const bad of ["fast", -5, 0, Number.POSITIVE_INFINITY]) {
      const src = freshSource();
      writeProgramManifest(src, {
        queue: { ...PROGRAM_TUNING.queue, retryBaseDelayMs: bad },
      });
      const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
      expect(result.composed).toBe(false);
    }
  });

  it("a broken envelope (missing base_version stamp) is rejected — provenance per ADR-0003 d7 is not optional", () => {
    const src = freshSource();
    writeProgramManifest(src, PROGRAM_TUNING, {
      envelope: { base_version: undefined },
    });
    const result = resolveFleetProgram({ entitlements: ENTITLED, overlaySource: src });
    expect(result.composed).toBe(false);
    expect(result.receipt.absence_reason).toBe("program-envelope-invalid");
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
    writeProgramManifest(src, PROGRAM_TUNING);
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
    writeProgramManifest(src, PROGRAM_TUNING);
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

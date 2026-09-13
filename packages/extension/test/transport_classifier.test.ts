// #1069 (fleet rearchitect P4a-1, ADR-0005 — row 3): the transport classifier.
//
// The taxonomy, asserted with the F-harness (on main, #1049/#1051):
//   · TRANSIENT (timeout, unreachable, handshake-fail, half-open) → posture
//     degraded — a badge, never a mode event.
//   · SUSTAINED (N consecutive no-responses, the substrate D6 hysteresis
//     carried over) → posture hub-down — never a mode change.
//   · RECOVERY → posture ok; the device's mode is what the human last
//     confirmed.
//   · ESCALATION: transient faults persisting past a wall-clock cap where
//     time-since-last-successful-fetch (locally measured) exceeds the cap → a
//     presumed-structural TYPED EVENT — never auto-applied.
//   · STRUCTURAL (auth-revoked, the D5 401 shape) → a typed event for the
//     P4a-3 proposal queue — no behavior beyond emission.
//
// THE F3 CORE (spec §8, the 09-13 train-wifi replay): every injected
// transport outcome leaves the MODE field untouched —
// n_transport_derived_mode_field_writes == 0.
//
// Thresholds/hysteresis are INJECTABLE CONFIG (the P4b fleet program composes
// them later as staged overlay data); base defaults ship (the D6 constants).
import { describe, it, expect, afterEach } from "vitest";
import {
  TransportClassifier,
  classifyProbeOutcome,
  DEFAULT_TRANSPORT_CLASSIFIER_CONFIG,
  type TransportSignal,
} from "../src/amicode_service/transport_classifier";
import {
  ModeMachine,
  type StructuralSignal,
} from "../src/amicode_service/attach_state";
import {
  DEGRADED_LATENCY_P95_MS,
  DEGRADED_WINDOW_SAMPLES,
  HUB_DOWN_CONSECUTIVE_NO_RESPONSES,
  RECOVERY_CONSECUTIVE_HEALTHY,
} from "../src/amicode_service/fleet_posture";
import { executeFleetWrite } from "../src/amicode_service/fleet_writes";
import {
  FaultProxy,
  probeOnce,
  runSchedule,
  startEchoBackend,
} from "./fixtures/fleet_fault_harness/fault_proxy";
import { FakeClock } from "./fixtures/fleet_fault_harness/test_clock";

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
  return { backend, proxy };
}

/** A classifier + machine pair under test, with the machine's human-confirmed
 *  mode pinned where the assertion needs one. */
function rig(opts: { config?: object; mode?: "standalone" | "fleet" } = {}) {
  const machine = new ModeMachine();
  if (opts.mode !== undefined) machine.confirmMode(opts.mode, "fixture: human confirm");
  const classifier = new TransportClassifier({
    machine,
    ...(opts.config !== undefined ? { config: opts.config as never } : {}),
  });
  return { machine, classifier };
}

// ══════════════════════════════════════════════════════════════════════════════
// The row-3 taxonomy — direct signals
// ══════════════════════════════════════════════════════════════════════════════

describe("#1069 transport classifier — the row-3 taxonomy", () => {
  it("a single transient fault (timeout) lands posture degraded — immediately, the row-3 rule", () => {
    const { machine, classifier } = rig({ mode: "fleet" });
    classifier.record({ kind: "no-response", fault: "timeout", detail: "client-enforced timeout" });
    const read = machine.read();
    expect(read.posture).toBe("degraded");
    expect(read.mode).toBe("fleet"); // never a mode event
    const log = machine.writeLog();
    expect(log[log.length - 1]).toMatchObject({ writer: "transport", field: "posture" });
  });

  it("every transient class lands degraded: unreachable, handshake-fail, half-open", () => {
    for (const fault of ["unreachable", "handshake-fail", "half-open"] as const) {
      const { machine, classifier } = rig();
      classifier.record({ kind: "no-response", fault });
      expect(machine.read().posture).toBe("degraded");
    }
  });

  it("sustained N consecutive no-responses land hub-down — the D6 hysteresis carried over (N = default 3)", () => {
    const { machine, classifier } = rig();
    classifier.record({ kind: "no-response", fault: "timeout" });
    classifier.record({ kind: "no-response", fault: "timeout" });
    expect(machine.read().posture).toBe("degraded"); // fewer than N: still degraded, never hub-down
    classifier.record({ kind: "no-response", fault: "timeout" });
    expect(machine.read().posture).toBe("hub-down");
  });

  it("repeated faults in the same posture write ONCE (render-only transitions, not a write per probe)", () => {
    const { machine, classifier } = rig();
    for (let i = 0; i < 5; i++) classifier.record({ kind: "no-response", fault: "timeout" });
    const writes = machine.writeLog().filter((w) => w.writer === "transport");
    expect(writes.length).toBe(2); // degraded, then hub-down — not five
  });

  it("recovery re-enters posture ok after the healthy streak (hysteresis; R = default 3)", () => {
    const { machine, classifier } = rig({ mode: "fleet" });
    for (let i = 0; i < 3; i++) classifier.record({ kind: "no-response", fault: "timeout" });
    expect(machine.read().posture).toBe("hub-down");
    classifier.record({ kind: "responded", latencyMs: 5 });
    classifier.record({ kind: "responded", latencyMs: 5 });
    expect(machine.read().posture).toBe("hub-down"); // one healthy answer is not recovery
    classifier.record({ kind: "responded", latencyMs: 5 });
    const read = machine.read();
    expect(read.posture).toBe("ok");
    expect(read.mode).toBe("fleet"); // the device's mode is what the human last confirmed
  });

  it("the D6 latency window carries over: p95 >= X over Y samples → degraded; exit needs the streak AND latency back under", () => {
    const { machine, classifier } = rig({ config: { degradedWindowSamples: 3 } });
    classifier.record({ kind: "responded", latencyMs: 2500 });
    classifier.record({ kind: "responded", latencyMs: 2500 });
    expect(machine.read().posture).toBe("ok"); // window not yet full — one slow sample must not flap
    classifier.record({ kind: "responded", latencyMs: 2500 });
    expect(machine.read().posture).toBe("degraded"); // hub-up-but-slow — a usable, honest steady state
    classifier.record({ kind: "responded", latencyMs: 5 });
    classifier.record({ kind: "responded", latencyMs: 2500 }); // window still hot
    expect(machine.read().posture).toBe("degraded");
    classifier.record({ kind: "responded", latencyMs: 5 });
    expect(machine.read().posture).toBe("degraded"); // the hot sample is still inside the window
    classifier.record({ kind: "responded", latencyMs: 5 });
    expect(machine.read().posture).toBe("degraded"); // streak made, window not yet cold
    classifier.record({ kind: "responded", latencyMs: 5 });
    expect(machine.read().posture).toBe("ok"); // latency genuinely back under across the flushed window
  });

  it("a single healthy answer inside a flap does NOT clear the badge (recovery keeps its hysteresis) — and the streak resets honestly", () => {
    const { machine, classifier } = rig();
    classifier.record({ kind: "no-response", fault: "timeout" });
    expect(machine.read().posture).toBe("degraded");
    classifier.record({ kind: "responded", latencyMs: 5 }); // a lone answered probe inside the flap
    expect(machine.read().posture).toBe("degraded"); // one answer is not recovery
    classifier.record({ kind: "no-response", fault: "half-open" });
    expect(machine.read().posture).toBe("degraded"); // still degraded — and the streak restarted at 1
    // render-once: the flap wrote the badge exactly once — no per-probe churn
    const writes = machine.writeLog().filter((w) => w.writer === "transport");
    expect(writes.map((w) => w.value)).toEqual(["degraded"]);
    classifier.record({ kind: "responded", latencyMs: 5 });
    classifier.record({ kind: "responded", latencyMs: 5 });
    classifier.record({ kind: "responded", latencyMs: 5 });
    expect(machine.read().posture).toBe("ok"); // the streak finally lands
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The escalation — presumed-structural, a typed event, FakeClock-driven
// ══════════════════════════════════════════════════════════════════════════════

describe("#1069 the fetch-age escalation (row 3) — presumed-structural, never auto-applied", () => {
  it("transient faults persisting past the cap emit ONE presumed-structural event — FakeClock-driven, zero wall-clock waits", () => {
    const clock = new FakeClock();
    const machine = new ModeMachine();
    const classifier = new TransportClassifier({
      machine,
      config: { escalationCapMs: 60_000 },
      nowMs: () => clock.now(),
    });
    classifier.record({ kind: "responded", latencyMs: 5 }); // t=0: last successful fetch
    expect(machine.structuralEvents().length).toBe(0);

    classifier.record({ kind: "no-response", fault: "timeout" }); // still inside the cap
    expect(machine.structuralEvents().length).toBe(0);
    expect(machine.read().posture).toBe("degraded");

    clock.advance(61_000); // the cap exceeded — time-since-last-successful-fetch, locally measured
    classifier.record({ kind: "no-response", fault: "timeout" });
    const events = machine.structuralEvents();
    expect(events.length).toBe(1);
    expect(events[0].class).toBe("presumed-structural");
    expect(machine.read().posture).toBe("degraded"); // an EVENT, never an auto-applied mode change

    classifier.record({ kind: "no-response", fault: "timeout" });
    expect(machine.structuralEvents().length).toBe(1); // once per episode — not a spam surface
  });

  it("a successful fetch resets the episode: a later past-cap fault escalates again", () => {
    const clock = new FakeClock();
    const machine = new ModeMachine();
    const classifier = new TransportClassifier({
      machine,
      config: { escalationCapMs: 60_000 },
      nowMs: () => clock.now(),
    });
    classifier.record({ kind: "responded", latencyMs: 5 });
    clock.advance(61_000);
    classifier.record({ kind: "no-response", fault: "timeout" });
    expect(machine.structuralEvents().length).toBe(1);
    classifier.record({ kind: "responded", latencyMs: 5 }); // fetch succeeds — episode over
    clock.advance(61_000);
    classifier.record({ kind: "no-response", fault: "timeout" });
    expect(machine.structuralEvents().length).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Config — injectable thresholds, base defaults ship (AC 7)
// ══════════════════════════════════════════════════════════════════════════════

describe("#1069 classifier config — injectable thresholds, base defaults ship", () => {
  it("the base defaults are the D6 constants carried over, plus the escalation cap (a placeholder the P4b program composes)", () => {
    expect(DEFAULT_TRANSPORT_CLASSIFIER_CONFIG).toEqual({
      hubDownConsecutiveNoResponses: HUB_DOWN_CONSECUTIVE_NO_RESPONSES,
      recoveryConsecutiveHealthy: RECOVERY_CONSECUTIVE_HEALTHY,
      degradedLatencyP95Ms: DEGRADED_LATENCY_P95_MS,
      degradedWindowSamples: DEGRADED_WINDOW_SAMPLES,
      escalationCapMs: 300_000,
    });
  });

  it("every knob is injectable — N, R, the latency threshold, the window, the cap", () => {
    const { machine, classifier } = rig({
      config: {
        hubDownConsecutiveNoResponses: 5,
        recoveryConsecutiveHealthy: 2,
        degradedLatencyP95Ms: 100,
        degradedWindowSamples: 3,
        escalationCapMs: 1_000,
      },
    });
    for (let i = 0; i < 4; i++) classifier.record({ kind: "no-response", fault: "timeout" });
    expect(machine.read().posture).toBe("degraded"); // custom N=5: four is not sustained
    classifier.record({ kind: "no-response", fault: "timeout" });
    expect(machine.read().posture).toBe("hub-down");
    classifier.record({ kind: "responded", latencyMs: 5 });
    expect(machine.read().posture).toBe("hub-down"); // custom R=2: one is not recovery
    classifier.record({ kind: "responded", latencyMs: 5 });
    expect(machine.read().posture).toBe("ok");
    // custom latency threshold + window
    classifier.record({ kind: "responded", latencyMs: 150 });
    classifier.record({ kind: "responded", latencyMs: 150 });
    classifier.record({ kind: "responded", latencyMs: 150 });
    expect(machine.read().posture).toBe("degraded");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The F-harness oracle — each fault mode lands in the right posture
// ══════════════════════════════════════════════════════════════════════════════

describe("#1069 the F-harness oracle — fault modes → transport signals → postures", () => {
  it("classifyProbeOutcome maps each harness outcome to its named signal class (the half-open bit is the handshake bytes)", () => {
    expect(classifyProbeOutcome({ kind: "response", body: "ECHO:PING" }, 4)).toEqual<TransportSignal>({
      kind: "responded",
      latencyMs: 4,
    });
    expect(classifyProbeOutcome({ kind: "timeout", handshakeBytes: 0 })).toEqual<TransportSignal>({
      kind: "no-response",
      fault: "timeout",
      detail: "client-enforced timeout, no handshake bytes",
    });
    expect(classifyProbeOutcome({ kind: "timeout", handshakeBytes: 20 })).toEqual<TransportSignal>({
      kind: "no-response",
      fault: "half-open",
      detail: "handshake bytes: 20",
    });
    expect(classifyProbeOutcome({ kind: "refused", code: "ECONNREFUSED" })).toEqual<TransportSignal>({
      kind: "no-response",
      fault: "unreachable",
      detail: "ECONNREFUSED",
    });
    expect(classifyProbeOutcome({ kind: "reset", code: "ECONNRESET" })).toEqual<TransportSignal>({
      kind: "no-response",
      fault: "unreachable",
      detail: "ECONNRESET",
    });
    expect(classifyProbeOutcome({ kind: "clean-close" })).toEqual<TransportSignal>({
      kind: "no-response",
      fault: "unreachable",
      detail: "clean-close: orderly EOF, zero payload",
    });
  });

  it("each fault mode lands degraded through the REAL proxy (DROP, HALF-OPEN, REFUSE, CLEAN-CLOSE)", async () => {
    for (const mode of ["drop", "half-open", "refuse", "clean-close"] as const) {
      const { proxy } = await startProxy(mode);
      const { machine, classifier } = rig();
      const outcome = await probeOnce(proxy.port, PROBE_DEADLINE_MS);
      classifier.record(classifyProbeOutcome(outcome));
      expect(machine.read().posture, `${mode} must land degraded`).toBe("degraded");
    }
  });

  it("a sustained window via the schedule lands hub-down, and PASS probes recover to ok", async () => {
    const { proxy } = await startProxy("drop");
    const { machine, classifier } = rig();
    const outcomes = await runSchedule(proxy, [
      { mode: "drop", probes: 3 },
      { mode: "pass", probes: 3 },
    ], PROBE_DEADLINE_MS);
    for (const o of outcomes) classifier.record(classifyProbeOutcome(o));
    const read = machine.read();
    expect(read.posture).toBe("ok"); // recovery landed after the 3-healthy streak
    const postures = machine.writeLog().filter((w) => w.writer === "transport").map((w) => w.value);
    expect(postures).toEqual(["degraded", "hub-down", "ok"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// THE F3 CORE — zero mode-field writes from any injected transport outcome
// ══════════════════════════════════════════════════════════════════════════════

describe("#1069 F3 — the train-wifi replay: the mode field is untouched by EVERY injected transport outcome", () => {
  it("the 09-13 shape (tunnel flapping) writes ONLY postures — n_transport_derived_mode_field_writes == 0", async () => {
    const { proxy } = await startProxy("pass");
    const { machine, classifier } = rig({ mode: "fleet" }); // the human confirmed fleet membership
    const modeBefore = machine.read().mode;
    expect(modeBefore).toBe("fleet");

    // the train-wifi replay: every fault mode, flapping through recoveries
    const outcomes = await runSchedule(proxy, [
      { mode: "pass", probes: 1 },
      { mode: "drop", probes: 2 },
      { mode: "half-open", probes: 2 },
      { mode: "pass", probes: 4 }, // clears the badge mid-replay
      { mode: "refuse", probes: 3 }, // a sustained window — hub-down POSTURE
      { mode: "clean-close", probes: 1 },
      { mode: "pass", probes: 4 }, // recovery
    ], PROBE_DEADLINE_MS);

    let probesSeen = 0;
    for (const o of outcomes) {
      classifier.record(classifyProbeOutcome(o));
      probesSeen++;
      // THE core assertion, per probe: the mode field is what the human last
      // confirmed — no transport outcome ever writes it
      expect(machine.read().mode, `mode after probe ${probesSeen}`).toBe("fleet");
    }

    // the mechanical counters (spec §8 F3):
    expect(machine.transportModeWriteCount()).toBe(0); // n_transport_derived_mode_field_writes == 0
    expect(machine.read().record.mode).toBe("fleet");
    const transportWrites = machine.writeLog().filter((w) => w.writer === "transport");
    expect(transportWrites.length).toBeGreaterThan(0); // the replay DID write postures…
    expect(transportWrites.every((w) => w.field === "posture")).toBe(true); // …and ONLY postures
    // the replay ends recovered, and the sustained window did land hub-down on the way
    expect(machine.read().posture).toBe("ok");
    const postureValues = transportWrites.map((w) => w.value);
    expect(postureValues).toContain("hub-down");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The auth-revoked seam — typed events from the write pipeline, nothing more
// ══════════════════════════════════════════════════════════════════════════════

describe("#1069 the auth-revoked structural seam (D5's 401 shape → a typed event for P4a-3)", () => {
  const HUB = "http://127.0.0.1:59999";
  const okCred = () =>
    ({ ok: true, mint: "hub", credential: { baseUrl: HUB, token: "hub-token" } }) as const;

  it("a 401 fleet write emits the auth-revoked typed event alongside the unchanged revocation handoff", async () => {
    const structural: StructuralSignal[] = [];
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: false }), { status: 401 })) as typeof fetch;
    const result = await executeFleetWrite(
      {
        getUrl: () => HUB,
        credential: okCred,
        fetchImpl,
        timeoutMs: 500,
        onStructural: (e) => structural.push(e),
      },
      { method: "POST", url: "/session", headers: {}, body: '{"title":"mid-flight draft"}' },
    );
    // the D5 handoff is unchanged (the existing contract, not re-decided here)
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.revocation?.handoff).toBe("read-only-with-pointer");
      expect(result.revocation?.go_standalone).toBe(true);
    }
    // the structural seam: ONE typed event, class auth-revoked
    expect(structural.length).toBe(1);
    expect(structural[0].kind).toBe("structural");
    expect(structural[0].class).toBe("auth-revoked");
  });

  it("the auth-revoked event rides the machine's surface WITHOUT any attach-state write (never auto-applied)", () => {
    const machine = new ModeMachine({ initial: { mode: "fleet", posture: "ok" } });
    const classifier = new TransportClassifier({ machine });
    const recordBefore = machine.read().record;
    const writesBefore = machine.writeLog().length;

    classifier.noteAuthRevoked("hub answered HTTP 401 mid-flight");

    const events = machine.structuralEvents();
    expect(events.length).toBe(1);
    expect(events[0].class).toBe("auth-revoked");
    expect(machine.read().record).toEqual(recordBefore); // no posture write, no mode write
    expect(machine.writeLog().length).toBe(writesBefore);
    expect(machine.read().posture).toBe("ok"); // revocation is honest unreachability, NOT degradation (D5)
  });

  it("onStructural is additive: absent, the write path behaves exactly as before (zero events, contract intact)", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: false }), { status: 401 })) as typeof fetch;
    const result = await executeFleetWrite(
      { getUrl: () => HUB, credential: okCred, fetchImpl, timeoutMs: 500 },
      { method: "POST", url: "/session", headers: {}, body: '{"title":"x"}' },
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.revocation).toBeDefined();
  });
});

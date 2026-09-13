// TRANSPORT CLASSIFIER (#1069 — fleet rearchitect P4a-1, row 3; the
// vocabulary law is amicissimo ADR-0005): derives posture from the transport
// outcome stream and writes ONLY the posture field, through the mode machine
// (attach_state.ts) as the SOLE attach-state writer. It has NO mode-writing
// surface at all — the 09-13 transport-flap mode-exit class is structurally
// impossible here, not merely discouraged.
//
// THE ROW-3 TAXONOMY (rearchitect spec §2.2 row 3, carried into ADR-0005):
//   · TRANSIENT (timeout, unreachable, handshake-fail, half-open) → posture
//     `degraded` + backoff — a badge, never a mode event. One transient
//     fault bads immediately: the split exists precisely so posture can
//     move freely and harmlessly.
//   · SUSTAINED (N consecutive no-responses — the substrate D6 hysteresis
//     carried over) → posture `hub-down` (base standalone + surfaced
//     pointer). Never a mode change.
//   · RECOVERY → posture `ok` (refetch-before-first-render; the device's
//     mode is what the human last confirmed).
//   · The D6 latency window carries over unchanged: p95 ≥ X over Y samples
//     → degraded (hub-up-but-slow — a usable, honest steady state); exit
//     needs the recovery streak AND latency back under the threshold.
//   · ESCALATION: transient faults persisting past a wall-clock cap where
//     TIME-SINCE-LAST-SUCCESSFUL-FETCH (locally measured — never a
//     projection-age computation, which D1 forbids) exceeds the cap → a
//     `presumed-structural` TYPED EVENT on the machine's structural surface.
//     Never auto-applied — the P4a-3 queue consumes it later.
//
// EVERY threshold and hysteresis window is INJECTABLE CONFIG — the fleet
// program (P4b) composes the fleet-specific values later as staged overlay
// data; base defaults ship (the D6 constants, carried over from
// fleet_posture.ts — one vocabulary source, not a fork).
//
// EVOLUTION NOTE — this is the fleet_posture.ts detector's write path MOVED
// to the mode machine, not a second D6 detector: the detector (the frozen
// pre-split surface) stays byte-identical for its legacy consumers (the
// consumer switch is P3b-2, out of this slice's scope); the classifier is
// the machine's posture-writing component and implements the AMENDED
// taxonomy. The classifier consumes the same outcome classes the transport
// already produces and the F-harness injects (probe outcomes map through
// classifyProbeOutcome — a structural type, no test-fixture import).
import {
  ModeMachine,
  type StructuralSignalClass,
} from "./attach_state";
import {
  DEGRADED_LATENCY_P95_MS,
  DEGRADED_WINDOW_SAMPLES,
  HUB_DOWN_CONSECUTIVE_NO_RESPONSES,
  RECOVERY_CONSECUTIVE_HEALTHY,
} from "./fleet_posture";

/** The transient fault classes of the row-3 taxonomy — each lands in
 *  posture degraded. They are NAMED classes (not "an error") so telemetry
 *  and the F3 oracle can assert exactly what was injected. */
export type TransientFaultClass = "timeout" | "unreachable" | "handshake-fail" | "half-open";

/** One classified transport outcome. The `responded` leg carries the
 *  measured latency (the D6 window's input); the `no-response` leg names
 *  its transient class — D6's client-enforced timeout discipline: the
 *  classifier observes outcomes the transport already resolved, it never
 *  awaits them. */
export type TransportSignal =
  | { kind: "responded"; latencyMs: number }
  | { kind: "no-response"; fault: TransientFaultClass; detail?: string };

/** The structural shape of an F-harness probe outcome (fault_proxy.ts's
 *  `Outcome` satisfies this structurally — src never imports the fixture). */
export type ProbeOutcomeLike =
  | { kind: "response"; body?: string }
  | { kind: "timeout"; handshakeBytes: number }
  | { kind: "refused"; code?: string }
  | { kind: "reset"; code?: string }
  | { kind: "clean-close" };

/** The labeled oracle's mapping — how the F-harness's five fault modes read
 *  as transport signals:
 *    PASS        → responded (the backend answered)
 *    DROP        → timeout (accepted, black-holed — zero handshake bytes)
 *    HALF-OPEN   → half-open (the accepted handshake's bytes arrived, then
 *                  silence — THE bit that distinguishes it from DROP)
 *    REFUSE      → unreachable (an active reject at the listen level)
 *    RESET       → unreachable (the connection was killed mid-flight)
 *    CLEAN-CLOSE → unreachable (orderly EOF, zero payload — the tunnel is
 *                  not delivering; a transient, not a mode fact)
 */
export function classifyProbeOutcome(outcome: ProbeOutcomeLike, latencyMs = 0): TransportSignal {
  switch (outcome.kind) {
    case "response":
      return { kind: "responded", latencyMs };
    case "timeout":
      return outcome.handshakeBytes > 0
        ? { kind: "no-response", fault: "half-open", detail: `handshake bytes: ${outcome.handshakeBytes}` }
        : { kind: "no-response", fault: "timeout", detail: "client-enforced timeout, no handshake bytes" };
    case "refused":
      return { kind: "no-response", fault: "unreachable", detail: outcome.code ?? "refused" };
    case "reset":
      return { kind: "no-response", fault: "unreachable", detail: outcome.code ?? "reset" };
    case "clean-close":
      return { kind: "no-response", fault: "unreachable", detail: "clean-close: orderly EOF, zero payload" };
  }
}

/** The classifier's config — every threshold and window is injectable (the
 *  P4b fleet program composes them; these base defaults ship). */
export interface TransportClassifierConfig {
  /** N of D6 (carried over): consecutive no-responses entering hub-down. */
  hubDownConsecutiveNoResponses: number;
  /** D6 (carried over): consecutive healthy outcomes re-entering ok. */
  recoveryConsecutiveHealthy: number;
  /** D6 (carried over): the p95 latency threshold (ms) for degraded entry
   *  (hub-up-but-slow). */
  degradedLatencyP95Ms: number;
  /** D6 (carried over): the latency measurement window (samples). */
  degradedWindowSamples: number;
  /** Row 3's escalation cap (ms): a transient fault persisting while
   *  time-since-last-successful-fetch exceeds this escalates to ONE
   *  presumed-structural EVENT (never auto-applied). The base default is a
   *  placeholder — the P4b program composes the fleet value. */
  escalationCapMs: number;
}

/** The shipped base defaults: the D6 constants carried over verbatim from
 *  fleet_posture.ts (one vocabulary source), plus the escalation cap. */
export const DEFAULT_TRANSPORT_CLASSIFIER_CONFIG: TransportClassifierConfig = {
  hubDownConsecutiveNoResponses: HUB_DOWN_CONSECUTIVE_NO_RESPONSES,
  recoveryConsecutiveHealthy: RECOVERY_CONSECUTIVE_HEALTHY,
  degradedLatencyP95Ms: DEGRADED_LATENCY_P95_MS,
  degradedWindowSamples: DEGRADED_WINDOW_SAMPLES,
  escalationCapMs: 300_000,
};

/** Nearest-rank p95 over the window (the window is tiny — sort is fine). */
function percentile95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx];
}

/** The transport classifier: a component of the mode machine's write path
 *  (row 3). Holds ONLY the hysteresis counters — the attach-state record is
 *  the machine's; this class derives posture transitions and hands them to
 *  `machine.writePosture`, the sole posture writer. It has no mode-writing
 *  API at all. */
export class TransportClassifier {
  private readonly machine: ModeMachine;
  private readonly config: TransportClassifierConfig;
  private readonly nowMs: () => number;
  private noResponseStreak = 0;
  private healthyStreak = 0;
  private window: number[] = [];
  private lastSuccessfulFetchMs: number;
  private escalated = false;

  constructor(opts: {
    machine: ModeMachine;
    /** Overrides on the base defaults (the P4b program's staged values land
     *  here). */
    config?: Partial<TransportClassifierConfig>;
    /** The local monotone clock (FakeClock in tests). Fetch-age is locally
     *  measured — never a projection-age computation. */
    nowMs?: () => number;
  }) {
    this.machine = opts.machine;
    this.config = { ...DEFAULT_TRANSPORT_CLASSIFIER_CONFIG, ...(opts.config ?? {}) };
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.lastSuccessfulFetchMs = this.nowMs();
  }

  /** Feed one classified transport outcome. Synchronous by contract (D6's
   *  discipline carried over: the classifier observes outcomes the transport
   *  already resolved, it never awaits them). */
  record(signal: TransportSignal): void {
    if (signal.kind === "responded") {
      this.healthyStreak++;
      this.noResponseStreak = 0;
      this.escalated = false; // a successful fetch ends the escalation episode
      this.lastSuccessfulFetchMs = this.nowMs();
      this.window.push(signal.latencyMs);
      if (this.window.length > this.config.degradedWindowSamples) this.window.shift();
      const p95 = percentile95(this.window);
      const current = this.machine.resolve().posture;
      if (current === "ok") {
        // D6's hub-up-but-slow ENTRY (carried over): p95 of a full window
        // over the threshold → degraded — a usable, honest steady state.
        if (
          this.window.length >= this.config.degradedWindowSamples &&
          p95 >= this.config.degradedLatencyP95Ms
        ) {
          this.machine.writePosture(
            "degraded",
            `latency-window: p95 of the last ${this.config.degradedWindowSamples} data-plane responses >= ${this.config.degradedLatencyP95Ms}ms (hub-up-but-slow)`,
          );
        }
        return;
      }
      if (current === "degraded") {
        if (
          this.healthyStreak >= this.config.recoveryConsecutiveHealthy &&
          p95 < this.config.degradedLatencyP95Ms
        ) {
          this.machine.writePosture(
            "ok",
            "recovered: latency back under threshold across the recovery streak",
          );
        }
        return;
      }
      if (current === "hub-down" && this.healthyStreak >= this.config.recoveryConsecutiveHealthy) {
        this.machine.writePosture("ok", "recovered: the hub answering again across the recovery streak");
      }
      return;
    }

    // no-response: a transient-class fault. Row 3: ONE transient bads
    // degraded immediately; the D6 hysteresis carries over for the
    // sustained window → hub-down.
    this.noResponseStreak++;
    this.healthyStreak = 0;
    const current = this.machine.resolve().posture;
    if (this.noResponseStreak >= this.config.hubDownConsecutiveNoResponses) {
      if (current !== "hub-down") {
        this.machine.writePosture(
          "hub-down",
          `sustained: ${this.noResponseStreak} consecutive no-responses (${signal.fault})`,
        );
      }
    } else if (current === "ok") {
      this.machine.writePosture(
        "degraded",
        `transient ${signal.fault}${signal.detail !== undefined ? ` (${signal.detail})` : ""}`,
      );
    }

    // The escalation (row 3): transient past a wall-clock cap where
    // time-since-last-successful-fetch — locally measured — exceeds it → a
    // presumed-structural EVENT (once per episode), never auto-applied.
    if (!this.escalated && this.nowMs() - this.lastSuccessfulFetchMs > this.config.escalationCapMs) {
      this.escalated = true;
      this.machine.emitStructural({
        class: "presumed-structural",
        detail:
          `transient faults persisting past the fetch-age cap: ` +
          `time-since-last-successful-fetch ${this.nowMs() - this.lastSuccessfulFetchMs}ms > cap ${this.config.escalationCapMs}ms`,
      });
    }
  }

  /** The auth-revoked structural signal (D5's 401 shape, relayed from the
   *  write pipeline's structural seam): a typed event for the P4a-3 queue —
   *  no posture write, no mode write, no auto-apply. Revocation is honest
   *  unreachability, NOT degradation. */
  noteAuthRevoked(detail?: string): void {
    this.machine.emitStructural({ class: "auth-revoked", ...(detail !== undefined ? { detail } : {}) });
  }

  /** The mode-changed-elsewhere structural signal (knowable via a fresh
   *  projection fetch, row 3): a typed event — the P4a-3 queue stages the
   *  proposal; nothing is applied here. */
  noteModeChangedElsewhere(detail?: string): void {
    this.machine.emitStructural({
      class: "mode-changed-elsewhere" satisfies StructuralSignalClass,
      ...(detail !== undefined ? { detail } : {}),
    });
  }
}

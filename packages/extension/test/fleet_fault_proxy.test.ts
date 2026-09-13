import { describe, it, expect, afterEach } from "vitest";
import {
  FaultProxy,
  probeOnce,
  runSchedule,
  startEchoBackend,
  HALF_OPEN_GREETING,
  type Outcome,
} from "./fixtures/fleet_fault_harness/fault_proxy";

// ============================================================================
// #1049 F-harness — the scriptable tunnel-fault proxy (spec-20260913-114814 §8,
// AC1 + AC4). Each fault mode must manifest as the CORRECT transport outcome —
// timeout vs reset vs refused vs orderly close vs response — not "an error":
//
//   DROP        → client timeout: accepted socket black-holed, zero bytes
//                 ever written, no EOF, no error (handshakeBytes === 0)
//   HALF-OPEN   → accepted handshake then silence: the greeting banner arrives,
//                 then the response never does and the socket never closes
//                 (handshakeBytes > 0 — THE bit that distinguishes it from DROP)
//   REFUSE      → ECONNREFUSED: active reject at the listen level
//   CLEAN-CLOSE → orderly FIN: prompt EOF, zero payload, no error
//   PASS        → normal proxying to the backend echo
//
// The schedule is a plan of {mode, probes} steps executed with every
// transition awaited — no sleeps as synchronization, no racing processes;
// the same plan reproduces the same outcome sequence. Sustained no-response
// windows (AC4) are consecutive same-mode probes observed by the consumer.
// ============================================================================

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

describe("FaultProxy — PASS mode proxies to the real backend", () => {
  it("delivers the echo response end to end (the PASS signature)", async () => {
    const { proxy } = await startProxy("pass");
    const out = await probeOnce(proxy.port, PROBE_DEADLINE_MS);
    expect(out).toEqual({ kind: "response", body: "ECHO:PING" });
    expect(proxy.stats.forwardedBytes).toBeGreaterThan(0);
    expect(proxy.stats.deliveredBytes).toBeGreaterThan(0);
  });
});

describe("FaultProxy — REFUSE is an active reject (ECONNREFUSED), not an error-ish reset", () => {
  it("client gets ECONNREFUSED while the refuse window is open", async () => {
    const { proxy } = await startProxy("pass");
    await proxy.setMode("refuse");
    const out = await probeOnce(proxy.port, PROBE_DEADLINE_MS);
    expect(out).toEqual({ kind: "refused", code: "ECONNREFUSED" });
  });

  it("exiting the refuse window reopens the SAME port and proxying resumes", async () => {
    const { proxy } = await startProxy("refuse");
    const portBefore = proxy.port;
    const refused = await probeOnce(proxy.port, PROBE_DEADLINE_MS);
    expect(refused).toEqual({ kind: "refused", code: "ECONNREFUSED" });
    await proxy.setMode("pass");
    expect(proxy.port).toBe(portBefore);
    const out = await probeOnce(proxy.port, PROBE_DEADLINE_MS);
    expect(out.kind).toBe("response");
  });
});

describe("FaultProxy — DROP black-holes the socket (client timeout, no handshake bytes)", () => {
  it("response never arrives, socket never closes, no error fires", async () => {
    const { proxy } = await startProxy("drop");
    const out = await probeOnce(proxy.port, PROBE_DEADLINE_MS);
    expect(out).toEqual({ kind: "timeout", handshakeBytes: 0 });
    // the deterministic core: the proxy accepted but forwarded NOTHING
    expect(proxy.stats.acceptedConnections).toBe(1);
    expect(proxy.stats.forwardedBytes).toBe(0);
    expect(proxy.stats.deliveredBytes).toBe(0);
  });
});

describe("FaultProxy — HALF-OPEN accepts the handshake then goes silent", () => {
  it("greeting arrives, then the response never does (hang, not EOF)", async () => {
    const { proxy } = await startProxy("half-open");
    const out = await probeOnce(proxy.port, PROBE_DEADLINE_MS);
    expect(out).toEqual({ kind: "timeout", handshakeBytes: HALF_OPEN_GREETING.length });
    expect(proxy.stats.acceptedConnections).toBe(1);
    expect(proxy.stats.forwardedBytes).toBe(0); // request consumed by the fault, never proxied
  });

  it("is distinguishable from DROP by the accepted handshake alone", async () => {
    const { proxy } = await startProxy("drop");
    const dropped = await probeOnce(proxy.port, PROBE_DEADLINE_MS);
    await proxy.setMode("half-open");
    const half = await probeOnce(proxy.port, PROBE_DEADLINE_MS);
    expect(dropped.kind).toBe("timeout");
    expect(half.kind).toBe("timeout");
    expect(dropped.handshakeBytes).toBe(0);
    expect(half.handshakeBytes).toBeGreaterThan(0);
  });
});

describe("FaultProxy — CLEAN-CLOSE is an orderly EOF with zero payload", () => {
  it("prompt EOF, no data, no error (distinct from DROP's hang and REFUSE's error)", async () => {
    const { proxy } = await startProxy("clean-close");
    const out = await probeOnce(proxy.port, PROBE_DEADLINE_MS);
    expect(out).toEqual({ kind: "clean-close" });
  });
});

describe("FaultProxy — the five fault modes are pairwise distinguishable", () => {
  it("no two modes share the same observable signature (a collision is a harness bug)", async () => {
    const { proxy } = await startProxy("pass");
    const modes = ["pass", "drop", "half-open", "clean-close", "refuse"] as const;
    const signatures: string[] = [];
    for (const mode of modes) {
      await proxy.setMode(mode);
      const out = await probeOnce(proxy.port, PROBE_DEADLINE_MS);
      signatures.push(signatureOf(out));
    }
    expect(new Set(signatures).size).toBe(modes.length);
  });
});

describe("FaultProxy — scripted schedules (deterministic, consumer-observed)", () => {
  it("AC4: a sustained no-response window of N consecutive outcomes ends when the mode flips", async () => {
    const { proxy } = await startProxy("pass");
    const outcomes = await runSchedule(proxy, [
      { mode: "drop", probes: 3 },
      { mode: "pass", probes: 1 },
    ]);
    expect(outcomes).toHaveLength(4);
    expect(outcomes.slice(0, 3).every((o) => o.kind === "timeout")).toBe(true);
    expect(outcomes[3].kind).toBe("response");
  });

  it("healthy-then-dead-then-healthy tunnel sequence reproduces from the plan (F4 shape)", async () => {
    const { proxy } = await startProxy("pass");
    const port = proxy.port;
    const outcomes = await runSchedule(proxy, [
      { mode: "pass", probes: 2 },
      { mode: "drop", probes: 2 },
      { mode: "pass", probes: 1 },
    ]);
    expect(outcomes.map((o) => o.kind)).toEqual([
      "response",
      "response",
      "timeout",
      "timeout",
      "response",
    ]);
    expect(proxy.port).toBe(port); // the tunnel endpoint never moved
  });

  it("a plan mixing refuse and half-open windows is observed exactly as scripted", async () => {
    const { proxy } = await startProxy("refuse");
    const outcomes = await runSchedule(proxy, [
      { mode: "refuse", probes: 2 },
      { mode: "half-open", probes: 1 },
      { mode: "clean-close", probes: 1 },
    ]);
    expect(outcomes.map((o) => o.kind)).toEqual([
      "refused",
      "refused",
      "timeout",
      "clean-close",
    ]);
    expect(outcomes[2].handshakeBytes).toBeGreaterThan(0);
  });
});

function signatureOf(out: Outcome): string {
  switch (out.kind) {
    case "response":
      return `response:${out.body}`;
    case "refused":
    case "reset":
      return `${out.kind}:${out.code}`;
    case "timeout":
      return `timeout:handshake=${out.handshakeBytes}`;
    case "clean-close":
      return "clean-close";
  }
}

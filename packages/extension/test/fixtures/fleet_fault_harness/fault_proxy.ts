// ============================================================================
// #1049 F-harness — the scriptable tunnel-fault proxy (spec-20260913-114814 §8).
//
// A loopback-only TCP proxy between a test client and a real backend, injecting
// one of five OBSERVABLY DISTINCT fault modes:
//
//   PASS        → normal bidirectional proxying
//   DROP        → accepted socket black-holed: no bytes ever flow, no EOF,
//                 no error — the client's only outcome is a timeout
//   HALF-OPEN   → the tunnel handshake is ACCEPTED (a greeting banner is
//                 delivered) and then silence — distinguishable from DROP by
//                 those handshake bytes alone
//   CLEAN-CLOSE → an orderly FIN: prompt EOF, zero payload, no error
//   REFUSE      → the listener itself is closed for the window: the client
//                 gets ECONNREFUSED (active reject, not a reset)
//
// Scheduling is a plan of {mode, probes} steps executed by runSchedule with
// every transition awaited — the same plan reproduces the same outcome
// sequence, there are no sleeps used as synchronization, and teardown waits
// for every socket to be gone (the H4 lesson). node:net / node:timers only.
// ============================================================================

import * as net from "node:net";
import { once } from "node:events";

export type FaultMode = "pass" | "drop" | "half-open" | "clean-close" | "refuse";

/** The banner HALF-OPEN delivers before going silent — the accepted handshake. */
export const HALF_OPEN_GREETING = "AMICO-TUNNEL-READY\n";

export const PROBE_REQUEST = "PING";

export type Outcome =
  | { kind: "response"; body: string }
  | { kind: "timeout"; handshakeBytes: number }
  | { kind: "refused"; code: string }
  | { kind: "reset"; code: string }
  | { kind: "clean-close" };

export type ScheduleStep = { mode: FaultMode; probes: number };

// ---------------------------------------------------------------------------
// The backend the proxy fronts: a trivial echo server (loopback, in-process).
// ---------------------------------------------------------------------------

export type EchoBackend = {
  port: number;
  close: () => Promise<void>;
};

export function startEchoBackend(): Promise<EchoBackend> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", (chunk: Buffer) => {
        socket.write("ECHO:" + chunk.toString("utf8"));
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: async () => {
          for (const s of sockets) s.destroy();
          sockets.clear();
          await closeServerFully(server);
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The proxy.
// ---------------------------------------------------------------------------

export class FaultProxy {
  private server: net.Server | null = null;
  private targetPort: number;
  private listening = false;
  private mode: FaultMode = "pass";
  private portValue = 0;
  private readonly sockets = new Set<net.Socket>();

  readonly stats = {
    acceptedConnections: 0,
    forwardedBytes: 0,
    deliveredBytes: 0,
  };

  constructor(opts: { targetPort: number }) {
    this.targetPort = opts.targetPort;
  }

  get port(): number {
    return this.portValue;
  }

  async listen(): Promise<void> {
    this.server = net.createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    this.portValue = (this.server.address() as net.AddressInfo).port;
    this.listening = true;
  }

  /**
   * Switch the injected fault mode. Transitions happen between probes (the
   * schedule runner awaits every probe); entering REFUSE closes the listener —
   * that is WHAT ECONNREFUSED is — and leaving it rebinds the SAME port.
   */
  async setMode(mode: FaultMode): Promise<void> {
    if (mode === this.mode) return;
    if (mode === "refuse") {
      if (this.listening) {
        this.destroyTracked();
        const server = this.server!;
        server.close();
        await once(server, "close");
        this.listening = false;
      }
      this.mode = "refuse";
      return;
    }
    if (this.mode === "refuse") {
      const server = this.server!;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.portValue, "127.0.0.1", resolve);
      });
      this.listening = true;
    }
    this.mode = mode;
  }

  get currentMode(): FaultMode {
    return this.mode;
  }

  /** Teardown waits for every socket and the listener to be gone (H4). */
  async close(): Promise<void> {
    if (!this.server) return;
    this.destroyTracked();
    const server = this.server;
    this.server = null;
    this.listening = false;
    await closeServerFully(server);
  }

  private destroyTracked(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
  }

  private onConnection(client: net.Socket): void {
    this.stats.acceptedConnections += 1;
    this.track(client);
    switch (this.mode) {
      case "pass":
        return this.proxyThrough(client);
      case "drop":
        // Accept and black-hole: never read, never write, never close.
        client.pause();
        return;
      case "half-open":
        // Deliver the accepted handshake, then silence forever.
        client.write(HALF_OPEN_GREETING);
        client.pause();
        return;
      case "clean-close":
        client.end();
        return;
      case "refuse":
        // Unreachable through the listener (it is closed); destroy defensively.
        client.destroy();
        return;
    }
  }

  private proxyThrough(client: net.Socket): void {
    const upstream = net.connect(this.targetPort, "127.0.0.1");
    this.track(upstream);
    client.on("data", (chunk: Buffer) => {
      this.stats.forwardedBytes += chunk.length;
      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      this.stats.deliveredBytes += chunk.length;
      client.write(chunk);
    });
    const tear = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", tear);
    upstream.on("error", tear);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.end());
  }
}

function closeServerFully(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((err) => (err && err.code !== "ERR_SERVER_NOT_RUNNING" ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// The harness client: one probe through the proxy, classified by outcome.
// ---------------------------------------------------------------------------

/**
 * Connect to the proxy, send PROBE_REQUEST, and classify what happens within
 * `deadlineMs`. The deadline is the timeout MECHANISM under test (DROP and
 * HALF-OPEN are defined by never answering) — every other mode resolves as
 * soon as its event fires, well inside the deadline.
 */
export function probeOnce(port: number, deadlineMs = 150): Promise<Outcome> {
  return new Promise((resolve) => {
    let settled = false;
    let received = "";
    let hadHandshake = 0;

    const socket = net.connect(port, "127.0.0.1");
    const timer = setTimeout(() => settle({ kind: "timeout", handshakeBytes: hadHandshake }), deadlineMs);

    function settle(out: Outcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(out);
    }

    socket.on("connect", () => {
      socket.write(PROBE_REQUEST);
    });
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (received.includes("ECHO:")) {
        settle({ kind: "response", body: received });
        return;
      }
      hadHandshake = received.length;
    });
    socket.on("end", () => settle({ kind: "clean-close" }));
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") settle({ kind: "refused", code: "ECONNREFUSED" });
      else settle({ kind: "reset", code: err.code ?? "UNKNOWN" });
    });
  });
}

/**
 * Execute a fault plan: for each step, flip the mode (awaited — including the
 * listener close/reopen that REFUSE is) and run that many consumer probes.
 * Consecutive same-mode steps ARE the sustained window; the returned outcome
 * log is what the consumer observed, in order, reproducibly from the plan.
 */
export async function runSchedule(
  proxy: FaultProxy,
  plan: ScheduleStep[],
  deadlineMs = 150,
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const step of plan) {
    await proxy.setMode(step.mode);
    for (let i = 0; i < step.probes; i++) {
      outcomes.push(await probeOnce(proxy.port, deadlineMs));
    }
  }
  return outcomes;
}

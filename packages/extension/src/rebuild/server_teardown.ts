/**
 * Pre-deploy server teardown (#1146, ADR 0020 lifecycle gap).
 *
 * The detached-spawn model lets the opencode server survive the extension
 * host's exit. A rebuild swaps the binary + dist underneath it; on reload,
 * the new extension tries to cold-spawn on the same port and hits a
 * ServeError (port occupied), while the health probe gets 401 from the old
 * server's password -> 30 s timeout -> boot failure.
 *
 * Fix: before deploying, read the handshake to find the PID, kill it, and
 * delete the handshake so the new extension cold-spawns cleanly.
 */

import { readHandshake, deleteHandshake, handshakePath } from "../server_handshake";

export interface TeardownResult {
  stopped: boolean;
  pid?: number;
  port?: number;
  method: "handshake" | "lsof-fallback" | "already-dead" | "no-server";
}

export interface TeardownDeps {
  log: (line: string) => void;
  /** Override the default configured port for the lsof fallback (tests). */
  fallbackPort?: number;
}

/**
 * Stop a surviving detached server before a rebuild deploy.
 *
 * 1. Read the handshake at ~/.amico/ops/server/standalone.json
 * 2. Kill the PID (SIGTERM, wait, SIGKILL fallback)
 * 3. Fall back to the configured port via exec if no handshake
 * 4. Delete the handshake file
 */
export async function stopSurvivingServer(deps: TeardownDeps): Promise<TeardownResult> {
  const hsPath = handshakePath();
  const hs = readHandshake(hsPath);
  let pid: number | undefined;
  let port: number | undefined;

  // 1. Try the handshake record first (authoritative).
  if (hs.status === "ok") {
    pid = hs.record.pid;
    port = hs.record.port;
    deps.log(`[teardown] handshake found: PID ${pid}, port ${port}`);
  }

  // 2. If no PID from handshake, fall back to lsof on the default port.
  if (pid === undefined) {
    const targetPort = deps.fallbackPort ?? 43117;
    try {
      const { execSync } = await import("node:child_process");
      const lsofOut = execSync(`lsof -ti :${targetPort}`, { timeout: 5000 })
        .toString()
        .trim();
      const firstPid = lsofOut.split("\n")[0]?.trim();
      if (firstPid && /^\d+$/.test(firstPid)) {
        pid = parseInt(firstPid, 10);
        port = targetPort;
        deps.log(`[teardown] no handshake, but PID ${pid} holds port ${targetPort} (lsof fallback)`);
      }
    } catch {
      // lsof not available or port free — no server to stop
    }
  }

  // 3. Nothing to stop.
  if (pid === undefined) {
    deps.log("[teardown] no surviving server to stop");
    deleteHandshake(hsPath);
    return { stopped: false, method: "no-server" };
  }

  // 4. Check if PID is alive.
  if (!isAlive(pid)) {
    deps.log(`[teardown] PID ${pid} is already dead — cleaning up handshake`);
    deleteHandshake(hsPath);
    return { stopped: false, pid, port, method: "already-dead" };
  }

  // 5. SIGTERM, then SIGKILL fallback.
  const method = hs.status === "ok" ? "handshake" as const : "lsof-fallback" as const;
  deps.log(`[teardown] stopping server PID ${pid} (port ${port ?? "?"})...`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone
    deleteHandshake(hsPath);
    return { stopped: true, pid, port, method };
  }

  // Wait up to 5 seconds for graceful exit.
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    if (!isAlive(pid)) {
      deps.log(`[teardown] server exited after SIGTERM`);
      deleteHandshake(hsPath);
      return { stopped: true, pid, port, method };
    }
  }

  // SIGKILL fallback.
  deps.log("[teardown] server did not exit after SIGTERM — sending SIGKILL");
  try {
    process.kill(pid, "SIGKILL");
  } catch { /* already gone */ }
  await sleep(1000);

  deleteHandshake(hsPath);
  deps.log("[teardown] server stopped and handshake cleared");
  return { stopped: true, pid, port, method };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

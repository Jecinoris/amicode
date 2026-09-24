// Round 5: one server. A live handshake whose config hash matches this
// session is joined with `opencode attach`. A live handshake with a different
// config is a conflict. A missing record or a dead pid falls through to a
// new TUI.
import { join } from "node:path";
import { handshakePath, hashString, readHandshake } from "../../extension/src/server_handshake.js";

export type ServerChoice =
  | { action: "launch" }
  | { action: "attach"; url: string; password: string }
  | { action: "conflict"; port: number };

/** ~/.amico/ops/server/standalone.json under `home`. */
export function handshakeFile(home: string): string {
  return handshakePath(join(home, ".amico", "ops"));
}

export function configHash(content: string): string {
  return hashString(content);
}

/** Signal 0 probes existence. Same check as isPidAlive in server_lifecycle.ts. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function chooseServer(
  file: string,
  hash: string,
  alive: (pid: number) => boolean = pidAlive,
): ServerChoice {
  const read = readHandshake(file);
  if (read.status !== "ok") return { action: "launch" };
  if (!alive(read.record.pid)) return { action: "launch" };
  if (read.record.configHash !== hash) return { action: "conflict", port: read.record.port };
  return {
    action: "attach",
    url: `http://127.0.0.1:${read.record.port}`,
    password: read.record.password,
  };
}

export function conflictMessage(port: number): string {
  return (
    `amicode: an extension server is still running on port ${port} with a different session config.\n` +
    "Quit that server before starting amicode here.\n"
  );
}

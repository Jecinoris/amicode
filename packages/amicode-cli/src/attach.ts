// A live handshake whose config hash matches this session is joined with
// `opencode attach`. Anything else starts a new TUI. The extension always
// serves on 43117 when a Cursor window opens, and that config is a different
// asset tree, so a hash mismatch must not block the CLI. The TUI listens on
// port 0 (an ephemeral port), not 43117.
import { join } from "node:path";
import { handshakePath, hashString, readHandshake } from "../../extension/src/server_handshake.js";

export type ServerChoice =
  | { action: "launch" }
  | { action: "attach"; url: string; password: string };

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
  if (read.record.configHash !== hash) return { action: "launch" };
  return {
    action: "attach",
    url: `http://127.0.0.1:${read.record.port}`,
    password: read.record.password,
  };
}

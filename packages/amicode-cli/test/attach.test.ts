import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chooseServer, handshakeFile } from "../src/attach.js";

function record(dir: string, fields: { pid: number; configHash: string; port?: number; password?: string }): string {
  const file = handshakeFile(dir);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      port: fields.port ?? 43117,
      pid: fields.pid,
      startedAt: "2026-09-24T00:00:00.000Z",
      password: fields.password ?? "secret",
      binaryHash: "b",
      configHash: fields.configHash,
      protocolVersion: "1",
    }),
  );
  return file;
}

describe("chooseServer", () => {
  it("launches when the handshake is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "amicode-attach-"));
    expect(chooseServer(handshakeFile(home), "abc", () => true)).toEqual({ action: "launch" });
  });

  it("launches when the recorded pid is dead", () => {
    const home = mkdtempSync(join(tmpdir(), "amicode-attach-"));
    const file = record(home, { pid: 424242, configHash: "same" });
    expect(chooseServer(file, "same", () => false)).toEqual({ action: "launch" });
  });

  it("attaches when the pid is alive and the config hash matches", () => {
    const home = mkdtempSync(join(tmpdir(), "amicode-attach-"));
    const file = record(home, { pid: 7, configHash: "same", port: 43117, password: "from-extension" });
    expect(chooseServer(file, "same", () => true)).toEqual({
      action: "attach",
      url: "http://127.0.0.1:43117",
      password: "from-extension",
    });
  });

  it("launches its own TUI when a live server has a different config", () => {
    const home = mkdtempSync(join(tmpdir(), "amicode-attach-"));
    const file = record(home, { pid: 7, configHash: "extension", port: 43117, password: "from-extension" });
    expect(chooseServer(file, "cli", () => true)).toEqual({ action: "launch" });
  });
});

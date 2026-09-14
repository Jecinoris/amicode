import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

describe("assert_ui_gate.sh", () => {
  // #823 re-based the gate's invariants for the M3 cutover: the framed app
  // comes from the service's SHELF (the app-bundle dist), so "the ENGINE's
  // embedded UI shows amicode surfaces" is no longer the contract. What the
  // vendored ENGINE must guarantee now: (1) it IS the pinned build — its
  // `--version` equals the lock's version; (2) it carries the `auth_token`
  // carrier machinery.
  const script = fileURLToPath(new URL("../scripts/assert_ui_gate.sh", import.meta.url));

  /** The vendor tree shape: <root>/opencode.lock.json +
   *  <root>/vendor/opencode/<platform>/opencode (a fake that prints `version`
   *  on --version and otherwise contains `body`). */
  const fixture = (
    version: string,
    body: string,
    opts: { lockVersion?: string; platform?: string } = {},
  ): { bin: string; root: string } => {
    const platform = opts.platform ?? `${process.platform}-${process.arch}`;
    const root = mkdtempSync(join(tmpdir(), "gate-"));
    const dir = join(root, "vendor", "opencode", platform);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(root, "opencode.lock.json"),
      JSON.stringify({ version: opts.lockVersion ?? version }),
    );
    const f = join(dir, "opencode");
    writeFileSync(f, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\n# ${body}\n`);
    chmodSync(f, 0o755);
    return { bin: f, root };
  };
  const run = (bin: string) => execFileSync("bash", [script, bin], { encoding: "utf8" });

  it("passes when the binary is the pinned build AND carries the auth_token carrier", () => {
    const { bin } = fixture("1.18.29", 'const AUTH_TOKEN_QUERY = "auth_token"');
    const out = run(bin);
    expect(out).toMatch(/pinned build \(1\.18\.29\)/);
    expect(out).toMatch(/auth_token/);
  });
  it("fails closed when the binary reports a version the lock does not pin", () => {
    const { bin } = fixture("1.18.10", 'const AUTH_TOKEN_QUERY = "auth_token"', { lockVersion: "1.18.29" });
    expect(() => run(bin)).toThrow();
  });
  it("fails closed when the auth_token carrier machinery is absent (the framed path would 401)", () => {
    const { bin } = fixture("1.18.29", "nothing relevant here");
    expect(() => run(bin)).toThrow();
  });
  it("fails when there is no lock beside the vendor tree (an unmoored binary)", () => {
    const { bin, root } = fixture("1.18.29", "auth_token machinery");
    rmSync(join(root, "opencode.lock.json"));
    expect(() => run(bin)).toThrow();
  });
  it("a foreign-arch binary skips the version re-assertion honestly but the carrier grep still applies", () => {
    const ok = fixture("9.9.9", 'const AUTH_TOKEN_QUERY = "auth_token"', {
      platform: "win32-x64",
      lockVersion: "1.18.29",
    });
    expect(run(ok.bin)).toMatch(/foreign-arch/);
    const noCarrier = fixture("1.18.29", "nothing relevant here", { platform: "win32-x64" });
    expect(() => run(noCarrier.bin)).toThrow();
  });
});

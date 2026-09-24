import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAssets, formatReport, reportOk, resolveAssetRoot, SUPPORTED_PLATFORMS } from "../src/assets.js";
import { run } from "../src/cli.js";

function touch(path: string, executable = false): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, executable ? "#!/bin/sh\nexit 0\n" : "x");
  if (executable) chmodSync(path, 0o755);
}

/** A complete asset tree laid out like the extension package, plus the sibling
 *  amico-run launcher the dev fallback resolves. */
function fixture(opts: { stagedLauncher?: boolean; siblingLauncher?: boolean; platformKey?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "amicode-cli-"));
  const asset = join(root, "extension");
  const platformKey = opts.platformKey ?? `${process.platform}-${process.arch}`;
  touch(join(asset, "vendor", "opencode", platformKey, "opencode"), true);
  touch(join(asset, "opencode-plugin", "amicode_context.ts"));
  touch(join(asset, "opencode-plugin", "stack_state.ts"));
  touch(join(asset, "bin", "dist", "mcp-amico.mjs"));
  touch(join(asset, "AGENTS.md"));
  for (const dir of ["scores", "packs", "skills", "templates"]) {
    mkdirSync(join(asset, dir), { recursive: true });
  }
  if (opts.stagedLauncher) {
    touch(join(asset, "bin", "launcher", "amico"), true);
    touch(join(asset, "bin", "launcher", "amico-run"), true);
  }
  if (opts.siblingLauncher !== false) {
    touch(join(root, "amico-run", "launcher", "amico"), true);
    touch(join(root, "amico-run", "launcher", "amico-run"), true);
  }
  return asset;
}

describe("resolveAssetRoot", () => {
  it("defaults to the sibling extension package", () => {
    expect(resolveAssetRoot({}, "/work/packages/amicode-cli")).toBe("/work/packages/extension");
  });

  it("uses AMICODE_ASSET_ROOT when set, even if the path is missing", () => {
    expect(resolveAssetRoot({ AMICODE_ASSET_ROOT: "  /opt/amicode  " }, "/work/packages/amicode-cli")).toBe("/opt/amicode");
  });
});

describe("checkAssets", () => {
  it("passes a complete dev tree via the sibling launcher", () => {
    const asset = fixture({ platformKey: "linux-x64" });
    const report = checkAssets(asset, "linux", "x64");
    expect(reportOk(report)).toBe(true);
    expect(formatReport(report)).toContain(`asset root: ${asset}`);
    expect(formatReport(report)).toContain("pass  amico-run");
    expect(report.checks.find((c) => c.id === "amico-run")?.path).toBe(join(asset, "..", "amico-run", "launcher", "amico-run"));
  });

  it("prefers the staged launcher over the sibling", () => {
    const asset = fixture({ stagedLauncher: true, platformKey: "linux-x64" });
    const report = checkAssets(asset, "linux", "x64");
    expect(report.checks.find((c) => c.id === "amico")?.path).toBe(join(asset, "bin", "launcher", "amico"));
  });

  it("fails the missing pieces and still lists every asset", () => {
    const asset = fixture({ siblingLauncher: false, platformKey: "linux-x64" });
    const report = checkAssets(asset, "linux", "x64");
    expect(reportOk(report)).toBe(false);
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.id);
    expect(failed).toEqual(["amico", "amico-run"]);
    expect(formatReport(report)).toContain("fail  amico");
    expect(formatReport(report)).toContain("also looked at");
  });

  it("fails an unsupported platform without treating a stray binary as present", () => {
    const asset = fixture({ platformKey: "linux-x64" });
    const report = checkAssets(asset, "win32", "x64");
    const binary = report.checks.find((c) => c.id.startsWith("vendor/opencode/"));
    expect(binary?.ok).toBe(false);
    expect(binary?.note).toContain("not supported");
    expect(SUPPORTED_PLATFORMS).toEqual(["darwin-arm64", "linux-arm64", "linux-x64"]);
  });
});

describe("amicode doctor", () => {
  it("prints the report and exits 0 for a complete tree", async () => {
    const asset = fixture();
    const result = await run(["doctor"], { ...process.env, AMICODE_ASSET_ROOT: asset });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("pass  opencode-plugin/amicode_context.ts");
    expect(result.stderr).toBe("");
  });

  it("exits 1 when an asset is missing", async () => {
    const asset = fixture();
    const result = await run(["doctor"], { ...process.env, AMICODE_ASSET_ROOT: join(asset, "missing") });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("fail  AGENTS.md");
  });

  it("refuses to start the TUI when the vendored binary is missing", async () => {
    const asset = mkdtempSync(join(tmpdir(), "amicode-cli-nobin-"));
    const result = await run([], { ...process.env, AMICODE_ASSET_ROOT: asset });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("vendored opencode missing");
    expect(result.stderr).toContain("amicode doctor");
    expect(result.stdout).toBe("");
  });
});

describe("launcher", () => {
  it("doctor exits 0 against a fixture tree", () => {
    const asset = fixture();
    const launcher = join(import.meta.dirname, "..", "launcher", "amicode");
    execFileSync("node", [join(import.meta.dirname, "..", "esbuild.config.mjs")], {
      cwd: join(import.meta.dirname, ".."),
    });
    const stdout = execFileSync(launcher, ["doctor"], {
      encoding: "utf8",
      env: { ...process.env, AMICODE_ASSET_ROOT: asset },
    });
    expect(stdout).toContain(`asset root: ${asset}`);
    expect(stdout).toContain("pass  bin/dist/mcp-amico.mjs");
  });
});

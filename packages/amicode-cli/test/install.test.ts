import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const installScript = join(import.meta.dirname, "..", "install.sh");

function fixture(): { asset: string; launcher: string } {
  const root = mkdtempSync(join(tmpdir(), "amicode-cli-install-src-"));
  const asset = join(root, "extension");
  mkdirSync(join(asset, "opencode-plugin"), { recursive: true });
  mkdirSync(join(asset, "bin", "dist"), { recursive: true });
  mkdirSync(join(asset, "templates"), { recursive: true });
  for (const dir of ["scores", "packs", "skills", "exemplars", "julia"]) mkdirSync(join(asset, dir), { recursive: true });
  writeFileSync(join(asset, "exemplars", "index.json"), "{}\n");
  writeFileSync(join(asset, "julia", "Project.toml"), "[deps]\n");
  writeFileSync(join(asset, "julia", "Manifest.toml"), "manifest\n");
  writeFileSync(join(asset, "AGENTS.md"), "julia {{JULIA_PROJECT}}\n");
  writeFileSync(join(asset, "templates", "solve_template.jl"), "template\n");
  writeFileSync(join(asset, "opencode-plugin", "amicode_context.ts"), "export {}\n");
  writeFileSync(join(asset, "opencode-plugin", "setup_state.ts"), "export const sibling = true;\n");
  writeFileSync(join(asset, "bin", "dist", "mcp-amico.mjs"), "export {}\n");
  writeFileSync(join(asset, "extension.js"), "do-not-copy\n");
  const launcher = join(root, "launcher");
  mkdirSync(launcher, { recursive: true });
  for (const name of ["amico", "amico-run"]) {
    const path = join(launcher, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  const binary = join(asset, "vendor", "opencode", `${process.platform}-${process.arch}`, "opencode");
  mkdirSync(join(binary, ".."), { recursive: true });
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.AMICODE_LAUNCH_RECEIPT, JSON.stringify({
  cwd: process.cwd(),
  argv: process.argv.slice(2),
}));
process.exit(0);
`,
  );
  chmodSync(binary, 0o755);
  return { asset, launcher };
}

function install(prefix: string, asset: string, launcher: string, juliaDir: string): void {
  execFileSync(
    "bash",
    [
      installScript,
      "--prefix",
      prefix,
      "--asset-root",
      asset,
      "--launcher-dir",
      launcher,
      "--julia-dir",
      juliaDir,
      "--no-instantiate",
    ],
    { cwd: join(import.meta.dirname, "..") },
  );
}

describe("amicode install", () => {
  it("installs a versioned tree and doctor passes outside the repo", () => {
    const script = readFileSync(installScript, "utf8");
    expect(script).not.toContain("install-extension");

    const { asset, launcher } = fixture();
    const home = mkdtempSync(join(tmpdir(), "amicode-cli-install-home-"));
    const prefix = join(home, ".local");
    const juliaDir = join(home, ".amico", "julia");
    const version = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version as string;
    install(prefix, asset, launcher, juliaDir);
    install(prefix, asset, launcher, juliaDir);

    const tree = join(prefix, "share", "amicode", version);
    const bin = join(prefix, "bin", "amicode");
    expect(readlinkSync(bin)).toBe(join(tree, "bin", "amicode"));
    expect(readFileSync(join(tree, "opencode-plugin", "setup_state.ts"), "utf8")).toContain("sibling");
    expect(existsSync(join(tree, "extension.js"))).toBe(false);
    expect(existsSync(join(tree, "bin", "dist", "amicode.cjs"))).toBe(true);
    expect(readFileSync(join(tree, "exemplars", "index.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(juliaDir, "Project.toml"), "utf8")).toBe("[deps]\n");
    expect(readFileSync(join(juliaDir, "Manifest.toml"), "utf8")).toBe("manifest\n");
    const shim = readFileSync(join(tree, "bin", "amicode"), "utf8");
    expect(shim).toContain("AMICODE_ASSET_ROOT");
    expect(shim).toContain('exec node "$ROOT/bin/dist/amicode.cjs"');

    const elsewhere = join(home, "not-the-repo");
    mkdirSync(elsewhere);
    const doctor = execFileSync(bin, ["doctor"], { cwd: elsewhere, encoding: "utf8" });
    expect(doctor).toContain(`asset root: ${tree}`);
    expect(doctor).not.toContain("fail");
    expect(doctor).toContain("pass  opencode-plugin/amicode_context.ts");
    expect(doctor).toContain("pass  bin/dist/mcp-amico.mjs");
  });

  it("opens the TUI from a directory outside the repo", () => {
    const { asset, launcher } = fixture();
    const home = mkdtempSync(join(tmpdir(), "amicode-cli-install-tui-"));
    const prefix = join(home, ".local");
    install(prefix, asset, launcher, join(home, ".amico", "julia"));
    const elsewhere = join(home, "not-the-repo");
    mkdirSync(elsewhere);
    const receipt = join(home, "receipt.json");
    execFileSync(join(prefix, "bin", "amicode"), [], {
      cwd: elsewhere,
      env: {
        ...process.env,
        HOME: home,
        AMICODE_PROBLEMS_DIR: join(home, "problems"),
        AMICODE_OPS_DIR: join(home, "ops"),
        AMICO_AUTHORING_FILE: join(home, "authoring.json"),
        AMICO_PROFILE_FILE: join(home, "profile.json"),
        AMICODE_LAUNCH_RECEIPT: receipt,
      },
    });
    const recorded = JSON.parse(readFileSync(receipt, "utf8")) as { cwd: string; argv: string[] };
    expect(recorded.cwd).toBe(elsewhere);
    expect(recorded.argv).toEqual([]);
  });
});

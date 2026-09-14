import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployBuild } from "../src/rebuild/coordinator";
import type { ExecResult } from "../src/rebuild/exec_types";

// ── Helpers ──

type ExecFn = (cmd: string, cwd?: string) => Promise<ExecResult>;

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "coord-test-"));
}

/** An exec mock where everything succeeds */
function happyExec(): ExecFn {
  return async (cmd: string) => {
    if (cmd.includes("node --version")) return { ok: true, stdout: "v22.0.0" };
    if (cmd.includes("git --version")) return { ok: true, stdout: "git version 2.43.0" };
    if (cmd.includes("pnpm --version")) return { ok: true, stdout: "9.15.9" };
    if (cmd.includes("gh --version")) return { ok: true, stdout: "gh version 2.40.0" };
    if (cmd.includes("bun --version")) return { ok: true, stdout: "1.1.0" };
    if (cmd.includes("git status --porcelain")) return { ok: true, stdout: "" };
    if (cmd.includes("git fetch")) return { ok: true, stdout: "" };
    if (cmd.includes("git checkout")) return { ok: true, stdout: "" };
    if (cmd.includes("git pull")) return { ok: true, stdout: "" };
    if (cmd.includes("git ls-remote")) return { ok: true, stdout: "ab".repeat(20) + "\trefs/heads/local/amicode\n" };
    if (cmd.includes("cat /proc/version")) return { ok: false, error: "no such file" }; // not WSL
    if (cmd.includes("xattr")) return { ok: true, stdout: "" };
    return { ok: true, stdout: "" };
  };
}

function makeExtDir(root: string): string {
  const extDir = join(root, "harmoniqs.amicode-0.2.0");
  const distDir = join(extDir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "extension.js"), "// old");
  writeFileSync(join(extDir, "package.json"), '{"name":"amicode"}');
  return extDir;
}

function makeBuildDir(root: string): string {
  const buildDir = join(root, "packages", "extension");
  const distDir = join(buildDir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "extension.js"), "// new");
  writeFileSync(join(buildDir, "package.json"), '{"name":"amicode","version":"0.2.0"}');
  return buildDir;
}

// ── Tests ──

describe("rebuild coordinator (#1016 integration)", () => {
  let cleanup: string[] = [];
  afterEach(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
    cleanup = [];
  });

  // ════════════════════════════════════════════════════════════════════════
  // Deployment: atomic swap (#1021)
  // ════════════════════════════════════════════════════════════════════════
  describe("deployBuild", () => {
    it("backs up, stages, swaps, and commits (no settings writes)", async () => {
      const root = tmpRoot();
      cleanup.push(root);
      const extDir = makeExtDir(root);
      const buildDir = makeBuildDir(root);

      const result = await deployBuild({
        extensionPath: extDir,
        buildDir,
        exec: happyExec(),
      });
      expect(result.ok).toBe(true);

      // New content should be in the extension dir
      expect(readFileSync(join(extDir, "dist", "extension.js"), "utf8")).toBe("// new");

      // Backup should exist as a sibling
      const parent = join(root);
      const backups = require("fs").readdirSync(parent).filter((f: string) => f.startsWith(".amicode-backup-"));
      expect(backups.length).toBeGreaterThanOrEqual(1);

      // Pending marker should be DELETED (committed)
      const markerPath = join(process.env.HOME ?? "~", ".amico", "rebuild-backups", "pending.json");
      expect(existsSync(markerPath)).toBe(false);
    });

    it("rolls back on bad staging dir", async () => {
      const root = tmpRoot();
      cleanup.push(root);
      const extDir = makeExtDir(root);
      // buildDir with no dist → staging will have no dist → swap will fail and roll back
      const emptyBuild = join(root, "empty-build");
      mkdirSync(emptyBuild, { recursive: true });

      const result = await deployBuild({
        extensionPath: extDir,
        buildDir: emptyBuild,
        exec: happyExec(),
      });

      // Should have rolled back — original content preserved
      expect(readFileSync(join(extDir, "dist", "extension.js"), "utf8")).toBe("// old");
    });

    it("never writes to VS Code settings.json", async () => {
      const root = tmpRoot();
      cleanup.push(root);
      const extDir = makeExtDir(root);
      const buildDir = makeBuildDir(root);

      // Track all exec calls — none should touch settings.json
      const cmds: string[] = [];
      const exec: ExecFn = async (cmd) => {
        cmds.push(cmd);
        return { ok: true, stdout: "" };
      };

      await deployBuild({ extensionPath: extDir, buildDir, exec });

      const settingsCmds = cmds.filter((c) =>
        c.includes("settings.json") || c.includes("update") || c.includes("devAssetRoot") || c.includes("opencodeBinary"),
      );
      expect(settingsCmds).toHaveLength(0);
    });
  });
});

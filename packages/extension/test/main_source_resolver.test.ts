import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Helpers ──

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rebuild-main-test-"));
}

function writeLock(root: string, lock: unknown): void {
  mkdirSync(join(root, "packages", "extension"), { recursive: true });
  writeFileSync(join(root, "packages", "extension", "opencode.lock.json"), JSON.stringify(lock));
}

const VALID_LOCK = {
  version: "1.18.29",
  base_version: "1.18.29",
  base_commit: "7fe993879f98aa17cecc70f70d3f40d6f0f11689",
  overlay_hash: "aa".repeat(32),
};

// ── Tests ──

describe("main_source_resolver", () => {
  let cleanup: string[] = [];

  afterEach(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
    cleanup = [];
  });

  async function importModule() {
    return import("../src/rebuild/main_source_resolver");
  }

  // ════════════════════════════════════════════════════════════════════════
  // readLockFile
  // ════════════════════════════════════════════════════════════════════════
  describe("readLockFile", () => {
    it("reads a valid lock file and returns its contents", async () => {
      const { readLockFile } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root, VALID_LOCK);

      const lock = readLockFile(root);
      expect(lock.version).toBe("1.18.29");
      expect(lock.base_commit).toBe("7fe993879f98aa17cecc70f70d3f40d6f0f11689");
      expect(lock.overlay_hash).toBe("aa".repeat(32));
    });

    it("throws a structured error when lock file is missing", async () => {
      const { readLockFile } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);

      expect(() => readLockFile(root)).toThrow(/opencode\.lock\.json/);
    });

    it("throws a structured error when lock file has no base_commit", async () => {
      const { readLockFile } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root, { ...VALID_LOCK, base_commit: undefined });

      expect(() => readLockFile(root)).toThrow(/base_commit/);
    });

    it("throws a structured error when lock file has no overlay_hash", async () => {
      const { readLockFile } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root, { ...VALID_LOCK, overlay_hash: undefined });

      expect(() => readLockFile(root)).toThrow(/overlay_hash/);
    });

    it("throws a structured error for malformed JSON", async () => {
      const { readLockFile } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      mkdirSync(join(root, "packages", "extension"), { recursive: true });
      writeFileSync(join(root, "packages", "extension", "opencode.lock.json"), "not json{");

      expect(() => readLockFile(root)).toThrow();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // resolveMainPlatform
  // ════════════════════════════════════════════════════════════════════════
  describe("resolveMainPlatform", () => {
    it("returns the current platform key when it is supported", async () => {
      const { resolveMainPlatform } = await importModule();
      const key = `${process.platform}-${process.arch}`;
      if (["darwin-arm64", "linux-arm64", "linux-x64"].includes(key)) {
        expect(resolveMainPlatform(VALID_LOCK)).toBe(key);
      }
    });

    it("throws unsupported error for darwin-x64", async () => {
      const { resolveMainPlatform, UnsupportedPlatformError } = await importModule();
      expect(() => resolveMainPlatform(VALID_LOCK, "darwin", "x64")).toThrow(UnsupportedPlatformError);
    });

    it("throws unsupported error for win32", async () => {
      const { resolveMainPlatform, UnsupportedPlatformError } = await importModule();
      expect(() => resolveMainPlatform(VALID_LOCK, "win32", "x64")).toThrow(UnsupportedPlatformError);
    });

    it("WSL resolves to linux-x64 (no special handling)", async () => {
      const { resolveMainPlatform } = await importModule();
      expect(resolveMainPlatform(VALID_LOCK, "linux", "x64")).toBe("linux-x64");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // checkDirtyTree
  // ════════════════════════════════════════════════════════════════════════
  describe("checkDirtyTree", () => {
    it("returns clean for a clean tree", async () => {
      const { checkDirtyTree } = await importModule();
      const result = await checkDirtyTree("/tmp/fake", async () => ({ ok: true, stdout: "" }));
      expect(result.dirty).toBe(false);
    });

    it("returns dirty with guidance when tree has uncommitted changes", async () => {
      const { checkDirtyTree } = await importModule();
      const result = await checkDirtyTree("/tmp/fake", async () => ({
        ok: true,
        stdout: " M packages/extension/src/chat_bridge.ts\n?? newfile.ts",
      }));
      expect(result.dirty).toBe(true);
      expect(result.message).toMatch(/commit or stash/i);
    });

    it("returns dirty on git failure", async () => {
      const { checkDirtyTree } = await importModule();
      const result = await checkDirtyTree("/tmp/fake", async () => ({
        ok: false,
        error: "not a git repo",
      }));
      expect(result.dirty).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // pullMainBranch
  // ════════════════════════════════════════════════════════════════════════
  describe("pullMainBranch", () => {
    it("runs git fetch + checkout main + pull --ff-only and succeeds", async () => {
      const { pullMainBranch } = await importModule();
      const commands: string[] = [];
      const exec = async (cmd: string) => {
        commands.push(cmd);
        return { ok: true, stdout: "" };
      };
      const result = await pullMainBranch("/tmp/repo", exec);
      expect(result.ok).toBe(true);
      expect(commands).toContain("git fetch origin");
      expect(commands).toContain("git checkout main");
      expect(commands).toContain("git pull --ff-only origin main");
    });

    it("uses --ff-only, not --rebase", async () => {
      const { pullMainBranch } = await importModule();
      const commands: string[] = [];
      const exec = async (cmd: string) => {
        commands.push(cmd);
        return { ok: true, stdout: "" };
      };
      await pullMainBranch("/tmp/repo", exec);
      const pullCmd = commands.find((c) => c.includes("git pull"));
      expect(pullCmd).toContain("--ff-only");
      expect(pullCmd).not.toContain("--rebase");
    });

    it("reports failure on non-fast-forward merge", async () => {
      const { pullMainBranch } = await importModule();
      const exec = async (cmd: string) => {
        if (cmd.includes("git pull")) {
          return { ok: false, error: "fatal: Not possible to fast-forward, aborting." };
        }
        return { ok: true, stdout: "" };
      };
      const result = await pullMainBranch("/tmp/repo", exec);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/fast-forward/i);
    });

    it("reports failure on fetch error", async () => {
      const { pullMainBranch } = await importModule();
      const exec = async (cmd: string) => {
        if (cmd.includes("git fetch")) {
          return { ok: false, error: "fatal: Could not read from remote repository." };
        }
        return { ok: true, stdout: "" };
      };
      const result = await pullMainBranch("/tmp/repo", exec);
      expect(result.ok).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // rebuildFromMain orchestration
  // ════════════════════════════════════════════════════════════════════════
  describe("rebuildFromMain", () => {
    it("refuses when tree is dirty", async () => {
      const { rebuildFromMain } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root, VALID_LOCK);

      const exec = async (cmd: string) => {
        if (cmd.includes("git status")) return { ok: true, stdout: " M dirty-file.ts" };
        return { ok: true, stdout: "" };
      };
      const result = await rebuildFromMain({
        amicodePath: root,
        exec,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/commit or stash/i);
    });

    it("refuses on unsupported platform", async () => {
      const { rebuildFromMain } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root, VALID_LOCK);

      const result = await rebuildFromMain({
        amicodePath: root,
        platformOverride: "win32",
        archOverride: "x64",
        exec: async () => ({ ok: true, stdout: "" }),
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/WSL|not supported|no.*build/i);
    });

    it("does not checkout, rebase, or mutate any fork clone", async () => {
      const { rebuildFromMain } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root, VALID_LOCK);

      const commands: string[] = [];
      const exec = async (cmd: string) => {
        commands.push(cmd);
        return { ok: true, stdout: "" };
      };

      try {
        await rebuildFromMain({ amicodePath: root, exec });
      } catch {
        // expected
      }

      const forkCommands = commands.filter(
        (c) => c.includes("local/amicode") || c.includes("bun install") || c.includes("bun run"),
      );
      expect(forkCommands).toHaveLength(0);
    });

    it("calls git pull --ff-only (not --rebase) on the amicode repo", async () => {
      const { rebuildFromMain } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root, VALID_LOCK);

      const commands: string[] = [];
      const exec = async (cmd: string) => {
        commands.push(cmd);
        return { ok: true, stdout: "" };
      };

      try {
        await rebuildFromMain({ amicodePath: root, exec });
      } catch {
        // expected
      }

      const pullCmds = commands.filter((c) => c.includes("git pull"));
      for (const cmd of pullCmds) {
        expect(cmd).toContain("--ff-only");
        expect(cmd).not.toContain("--rebase");
      }
    });
  });
});

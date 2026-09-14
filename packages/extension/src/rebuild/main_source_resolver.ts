/**
 * Main Source Resolver — #1018, updated for post-absorption (#1098)
 *
 * Resolves the binary for "Rebuild from Main" by reading the lock file
 * (opencode.lock.json on main) and downloading from the upstream release.
 * Post-absorption: no fork repo, no fork tag, no per-platform hashes in
 * the lock — binaries are built from the committed overlay.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unsupportedHostAdvice, SUPPORTED } from "../opencode_binary";

// ── Types ──

export interface LockFile {
  version: string;
  base_version: string;
  base_commit: string;
  overlay_hash: string;
}

export interface ExecResult {
  ok: boolean;
  stdout?: string;
  error?: string;
}

export type ExecFn = (cmd: string, cwd?: string) => Promise<ExecResult>;

export class UnsupportedPlatformError extends Error {
  constructor(public advice: string) {
    super(advice);
    this.name = "UnsupportedPlatformError";
  }
}

export class LockFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockFileError";
  }
}

// ── readLockFile ──

/**
 * Read and validate opencode.lock.json from the amicode repo root.
 * Post-absorption schema: version, base_version, base_commit, overlay_hash.
 */
export function readLockFile(amicodePath: string): LockFile {
  const lockPath = join(amicodePath, "packages", "extension", "opencode.lock.json");
  if (!existsSync(lockPath)) {
    throw new LockFileError(
      `opencode.lock.json not found at ${lockPath}. ` +
      `Ensure you are pointing at the amicode repo root.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (e) {
    throw new LockFileError(
      `opencode.lock.json is malformed: ${e instanceof Error ? e.message : "parse error"}`,
    );
  }

  const m = raw as Record<string, unknown>;

  if (typeof m.version !== "string" || m.version === "") {
    throw new LockFileError("opencode.lock.json: version must be a non-empty string");
  }

  if (typeof m.base_commit !== "string" || !/^[0-9a-f]{40}$/.test(m.base_commit)) {
    throw new LockFileError(
      "opencode.lock.json: base_commit must be a 40-character hex SHA " +
      "(it identifies the stock canonical upstream commit)",
    );
  }

  if (typeof m.overlay_hash !== "string" || m.overlay_hash === "") {
    throw new LockFileError("opencode.lock.json: overlay_hash is required");
  }

  return m as unknown as LockFile;
}

// ── resolveMainPlatform ──

/**
 * Resolve the current platform key. Post-absorption: no per-platform entries
 * in the lock — just check against the SUPPORTED constant.
 */
export function resolveMainPlatform(
  _lock: LockFile,
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const key = `${platform}-${arch}`;

  if (!(SUPPORTED as readonly string[]).includes(key)) {
    throw new UnsupportedPlatformError(unsupportedHostAdvice(platform, arch));
  }

  return key;
}

// ── checkDirtyTree ──

export async function checkDirtyTree(
  repoPath: string,
  exec: ExecFn,
): Promise<{ dirty: boolean; message?: string }> {
  const result = await exec("git status --porcelain", repoPath);
  if (!result.ok) {
    return { dirty: true, message: `Could not check tree status: ${result.error}` };
  }
  const output = (result.stdout ?? "").trim();
  if (output !== "") {
    return {
      dirty: true,
      message: "Commit or stash your local changes before rebuilding from main.",
    };
  }
  return { dirty: false };
}

// ── pullMainBranch ──

export async function pullMainBranch(
  amicodePath: string,
  exec: ExecFn,
): Promise<{ ok: boolean; error?: string }> {
  const fetch = await exec("git fetch origin", amicodePath);
  if (!fetch.ok) {
    return { ok: false, error: `git fetch failed: ${fetch.error}` };
  }

  const checkout = await exec("git checkout main", amicodePath);
  if (!checkout.ok) {
    return { ok: false, error: `git checkout main failed: ${checkout.error}` };
  }

  const pull = await exec("git pull --ff-only origin main", amicodePath);
  if (!pull.ok) {
    return { ok: false, error: `git pull failed (non-fast-forward?): ${pull.error}` };
  }

  return { ok: true };
}

// ── downloadBinary ──

export interface DownloadOpts {
  amicodePath: string;
  platform?: string;
  download?: (url: string) => Promise<Buffer>;
  ghApi?: (repo: string, path: string, jq: string) => string;
}

/**
 * Download the binary using the existing fetchFromRelease infrastructure.
 */
export async function downloadForkBinary(opts: DownloadOpts): Promise<{
  path: string;
  source: string;
  skipped: boolean;
}> {
  const { fetchOpencode } = await import("../../scripts/fetch_opencode.mjs");

  try {
    const result = await fetchOpencode({
      root: join(opts.amicodePath, "packages", "extension"),
      platform: opts.platform,
      download: opts.download,
      ghApi: opts.ghApi,
    });
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("404") || msg.includes("not found") || msg.includes("Not Found")) {
      const lock = readLockFile(opts.amicodePath);
      throw new Error(
        `The release \`v${lock.version}\` is no longer available. ` +
        `This may be a repository issue — contact your team.`,
      );
    }
    throw e;
  }
}

// ── rebuildFromMain (orchestrator) ──

export interface RebuildFromMainOpts {
  amicodePath: string;
  exec?: ExecFn;
  platformOverride?: string;
  archOverride?: string;
  download?: (url: string) => Promise<Buffer>;
  ghApi?: (repo: string, path: string, jq: string) => string;
  onPhase?: (phase: string, detail?: string) => void;
}

export interface RebuildResult {
  ok: boolean;
  error?: string;
  binaryPath?: string;
}

export async function rebuildFromMain(opts: RebuildFromMainOpts): Promise<RebuildResult> {
  const exec: ExecFn = opts.exec ?? defaultExec;
  const onPhase = opts.onPhase ?? (() => {});

  // ── Step 1: Check dirty tree ──
  onPhase("checking", "Checking working tree...");
  const dirty = await checkDirtyTree(opts.amicodePath, exec);
  if (dirty.dirty) {
    return { ok: false, error: dirty.message };
  }

  // ── Step 2: Detect unsupported platform ──
  let lock: LockFile | undefined;
  try {
    lock = readLockFile(opts.amicodePath);
  } catch {
    // Lock file may not exist before pull
  }

  if (lock) {
    try {
      resolveMainPlatform(lock, opts.platformOverride, opts.archOverride);
    } catch (e) {
      if (e instanceof UnsupportedPlatformError) {
        return { ok: false, error: e.advice };
      }
      throw e;
    }
  }

  // ── Step 3: Pull main (--ff-only) ──
  onPhase("pulling", "Pulling main...");
  const pull = await pullMainBranch(opts.amicodePath, exec);
  if (!pull.ok) {
    return { ok: false, error: pull.error };
  }

  // ── Step 4: Read lock file (after pull) ──
  onPhase("reading", "Reading lock file...");
  try {
    lock = readLockFile(opts.amicodePath);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to read lock file",
    };
  }

  let platformKey: string;
  try {
    platformKey = resolveMainPlatform(lock, opts.platformOverride, opts.archOverride);
  } catch (e) {
    if (e instanceof UnsupportedPlatformError) {
      return { ok: false, error: e.advice };
    }
    throw e;
  }

  // ── Step 5: Download binary ──
  onPhase("downloading", `Downloading binary for ${platformKey}...`);
  let binaryResult: { path: string; source: string; skipped: boolean };
  try {
    binaryResult = await downloadForkBinary({
      amicodePath: opts.amicodePath,
      platform: platformKey,
      download: opts.download,
      ghApi: opts.ghApi,
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Binary download failed",
    };
  }

  return {
    ok: true,
    binaryPath: binaryResult.path,
  };
}

// ── Default exec implementation ──

function defaultExec(cmd: string, cwd?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { exec } = require("node:child_process");
    exec(cmd, { cwd, timeout: 180_000 }, (err: Error | null, stdout: string, stderr: string) => {
      if (err) resolve({ ok: false, error: stderr?.trim() || err.message });
      else resolve({ ok: true, stdout: stdout?.toString() ?? "" });
    });
  });
}

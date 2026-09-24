// Round 4: foreground exec of the vendored opencode TUI. No extra args, no
// daemon, no `opencode serve`. The process cwd is the directory amicode was
// started in — that is the session the TUI edits. AGENTS.md stays in the
// prepared project dir and is referenced by absolute path in the config.
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

export function vendoredOpencodeBinary(
  assetRoot: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return join(assetRoot, "vendor", "opencode", `${platform}-${arch}`, "opencode");
}

export function binaryReady(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run the TUI in the foreground. Resolves with the child's exit code. */
export function launchOpencode(opts: { binary: string; cwd: string; env: NodeJS.ProcessEnv }): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.binary, [], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

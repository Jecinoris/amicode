// Asset-root resolution for the standalone `amicode` command (docs/amicode-cli.md,
// round 1). The dev root is the extension package; an install sets
// AMICODE_ASSET_ROOT. This module only looks at the filesystem — it does not
// write config or spawn a process.
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Platforms that ship a vendored opencode binary. Keep in lockstep with
 *  SUPPORTED in packages/extension/src/opencode_binary.ts. */
export const SUPPORTED_PLATFORMS = ["darwin-arm64", "linux-arm64", "linux-x64"] as const;

export interface AssetCheck {
  id: string;
  ok: boolean;
  path: string;
  note?: string;
}

export interface AssetReport {
  root: string;
  checks: AssetCheck[];
}

/** Package directory of amicode-cli. The bundled launcher is dist/amicode.cjs,
 *  one level below the package. Tests load this file from src/, where
 *  import.meta.url is the real module URL. */
export function packageDir(argv1: string | undefined = process.argv[1]): string {
  if (argv1 && argv1.endsWith(join("dist", "amicode.cjs"))) return join(dirname(argv1), "..");
  const metaUrl = import.meta.url;
  if (metaUrl) return join(dirname(fileURLToPath(metaUrl)), "..");
  // The cjs bundle has no import.meta. Callers that load it from a test runner
  // pass AMICODE_ASSET_ROOT, so this value is not used as the asset root.
  return dirname(argv1 ?? process.cwd());
}

/** Dev default is the sibling extension package. A non-empty AMICODE_ASSET_ROOT
 *  wins, including when that path does not exist — doctor then fails the root. */
export function resolveAssetRoot(env: NodeJS.ProcessEnv, pkgDir: string): string {
  const override = env.AMICODE_ASSET_ROOT?.trim();
  if (override) return override;
  return join(pkgDir, "..", "extension");
}

/** Same rule as resolveAmicoRunBinDir in packages/extension/src/opencode_paths.ts:
 *  staged `<root>/bin/launcher` when it contains `amico-run`, else the workspace
 *  sibling `packages/amico-run/launcher`. */
export function resolveAmicoLauncherDir(assetRoot: string): string | undefined {
  const staged = join(assetRoot, "bin", "launcher");
  if (existsSync(join(staged, "amico-run"))) return staged;
  const sibling = join(assetRoot, "..", "amico-run", "launcher");
  if (existsSync(join(sibling, "amico-run"))) return sibling;
  return undefined;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return isFile(path);
  } catch {
    return false;
  }
}

export function checkAssets(
  root: string,
  platform: string = process.platform,
  arch: string = process.arch,
): AssetReport {
  const checks: AssetCheck[] = [];
  const key = `${platform}-${arch}`;
  const binary = join(root, "vendor", "opencode", key, "opencode");
  if (!(SUPPORTED_PLATFORMS as readonly string[]).includes(key)) {
    checks.push({
      id: `vendor/opencode/${key}/opencode`,
      ok: false,
      path: binary,
      note: `platform ${key} is not supported (built: ${SUPPORTED_PLATFORMS.join(", ")})`,
    });
  } else {
    checks.push({
      id: `vendor/opencode/${key}/opencode`,
      ok: isExecutable(binary),
      path: binary,
    });
  }

  const plugin = join(root, "opencode-plugin", "amicode_context.ts");
  checks.push({
    id: "opencode-plugin/amicode_context.ts",
    ok: isDir(join(root, "opencode-plugin")) && isFile(plugin),
    path: plugin,
  });

  const mcp = join(root, "bin", "dist", "mcp-amico.mjs");
  checks.push({ id: "bin/dist/mcp-amico.mjs", ok: isFile(mcp), path: mcp });

  const agents = join(root, "AGENTS.md");
  checks.push({ id: "AGENTS.md", ok: isFile(agents), path: agents });

  for (const dir of ["scores", "packs", "skills", "templates"] as const) {
    const path = join(root, dir);
    checks.push({ id: `${dir}/`, ok: isDir(path), path });
  }

  const launcherDir = resolveAmicoLauncherDir(root);
  const stagedLauncher = join(root, "bin", "launcher");
  const siblingLauncher = join(root, "..", "amico-run", "launcher");
  for (const name of ["amico", "amico-run"] as const) {
    const path = launcherDir ? join(launcherDir, name) : join(stagedLauncher, name);
    const ok = launcherDir !== undefined && isExecutable(path);
    checks.push({
      id: name,
      ok,
      path,
      note: launcherDir === undefined ? `also looked at ${join(siblingLauncher, name)}` : undefined,
    });
  }

  return { root, checks };
}

export function reportOk(report: AssetReport): boolean {
  return report.checks.every((check) => check.ok);
}

export function formatReport(report: AssetReport): string {
  const lines = [`asset root: ${report.root}`];
  for (const check of report.checks) {
    const status = check.ok ? "pass" : "fail";
    const note = check.note ? `  ${check.note}` : "";
    lines.push(`${status}  ${check.id}  ${check.path}${note}`);
  }
  return `${lines.join("\n")}\n`;
}

// ~/.amico/cli.json. Kept free of the extension import graph so `doctor`
// can load without it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export class CliSettingsError extends Error {}

export interface CliSettings {
  juliaProject?: string;
  vaultDir?: string;
  skillRoots?: string[];
  defaultModel?: string;
}

/** A missing file is the extension's unset-settings defaults. */
export function cliSettingsPath(home: string = homedir()): string {
  return join(home, ".amico", "cli.json");
}

/** Stable project dir for this working directory. Re-preparing overwrites it. */
export function projectDirForCwd(cwd: string, home: string = homedir()): string {
  const hash = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  return join(home, ".amico", "cli", "projects", hash, "opencode-project");
}

function blankToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function readCliSettings(file: string): CliSettings {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new CliSettingsError(`amicode: ${file} is not valid JSON (${detail})`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliSettingsError(`amicode: ${file} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const skillRoots = Array.isArray(obj.skillRoots)
    ? obj.skillRoots.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim())
    : undefined;
  return {
    juliaProject: blankToUndefined(obj.juliaProject),
    vaultDir: blankToUndefined(obj.vaultDir),
    skillRoots: skillRoots && skillRoots.length > 0 ? skillRoots : undefined,
    defaultModel: blankToUndefined(obj.defaultModel),
  };
}

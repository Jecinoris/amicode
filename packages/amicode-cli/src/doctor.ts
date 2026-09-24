// Round 7: doctor lines that do not change the asset-tree exit code, plus the
// facts `amicode auth` is expected to leave behind. No key material is returned.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CliSettings } from "./settings.js";

const PROVIDER_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY"] as const;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** ~/.amico/julia, or the cli.json override, with `~` expanded under `home`. */
export function juliaProjectPath(home: string, settings: CliSettings): string {
  const value = (settings.juliaProject ?? "").trim();
  if (value === "") return join(home, ".amico", "julia");
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

function fileHasCredential(path: string): boolean {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof data !== "object" || data === null) return false;
    const record = data as Record<string, unknown>;
    const accounts = record.version === 2 && typeof record.accounts === "object" && record.accounts !== null
      ? Object.values(record.accounts as Record<string, unknown>)
      : Object.values(record);
    return accounts.some((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const obj = entry as {
        type?: unknown;
        key?: unknown;
        token?: unknown;
        credential?: { type?: unknown; key?: unknown; token?: unknown };
      };
      const cred = obj.credential ?? obj;
      const key = typeof cred.key === "string" ? cred.key.trim() : "";
      const token = typeof cred.token === "string" ? cred.token.trim() : "";
      if (cred.type === "api" && key !== "") return true;
      return token !== "";
    });
  } catch {
    return false;
  }
}

/** True when opencode's auth store or a provider env var has a credential.
 *  The value is never included in the result. */
export function providerAuthPresent(home: string, env: NodeJS.ProcessEnv): boolean {
  if (PROVIDER_ENV.some((name) => (env[name] ?? "").trim() !== "")) return true;
  const data = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  const dir = join(data, "opencode");
  return fileHasCredential(join(dir, "auth.json")) || fileHasCredential(join(dir, "account.json"));
}

/** Extra doctor lines. Callers keep the asset-tree exit code. */
export function runtimeReport(opts: { home: string; env: NodeJS.ProcessEnv; settings: CliSettings }): string {
  const project = juliaProjectPath(opts.home, opts.settings);
  const julia = isDir(project) ? `pass  julia  ${project}` : `note  julia  missing — solves will block  ${project}`;
  const auth = providerAuthPresent(opts.home, opts.env) ? "pass  provider auth" : "note  provider auth  missing — run amicode auth";
  return [`pass  node  ${process.version}`, auth, julia, ""].join("\n");
}

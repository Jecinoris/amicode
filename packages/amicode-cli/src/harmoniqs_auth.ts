// Harmoniqs is not in opencode's provider list, so `opencode auth login` cannot
// register it. This writes the same provider entry and auth-store key the
// extension's onboarding writes. The key never goes into opencode.json.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

export const HARMONIQS_PROVIDER_ID = "harmoniqs";
export const HARMONIQS_MODEL_ID = "harmoniqs-auto";
const HARMONIQS_BASE_URL = "https://app.harmoniqs.ai/v1";
const HARMONIQS_CONTEXT_TOKENS = 500_000;
const HARMONIQS_MAX_OUTPUT_TOKENS = 4096;

export function harmoniqsPaths(home: string, env: NodeJS.ProcessEnv): { configPath: string; authPath: string } {
  const configBase = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const dataBase = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  return {
    configPath: join(configBase, "opencode", "opencode.json"),
    authPath: join(dataBase, "opencode", "auth.json"),
  };
}

/** Same bar as the extension: non-empty, not the known placeholder, at least 10 characters. */
export function acceptableApiKey(key: string): boolean {
  const trimmed = key.trim();
  return trimmed !== "" && trimmed !== "sk-test" && trimmed.length >= 10;
}

/** Merge the Harmoniqs provider into opencode.json and store the key in auth.json. */
export function writeHarmoniqsAuth(opts: {
  apiKey: string;
  configPath: string;
  authPath: string;
}): void {
  const key = opts.apiKey.trim();
  if (!acceptableApiKey(key)) {
    throw new Error("amicode: harmoniqs API key was not saved");
  }

  mkdirSync(join(opts.configPath, ".."), { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(opts.configPath)) existing = JSON.parse(readFileSync(opts.configPath, "utf8"));
  } catch {
    existing = {};
  }
  const providers = (existing.provider ?? {}) as Record<string, unknown>;
  const current = (providers[HARMONIQS_PROVIDER_ID] ?? {}) as Record<string, unknown>;
  const model = {
    name: "Harmoniqs Auto",
    limit: { context: HARMONIQS_CONTEXT_TOKENS, output: HARMONIQS_MAX_OUTPUT_TOKENS },
    tool_call: true,
  };
  const next = {
    ...existing,
    $schema: "https://opencode.ai/config.json",
    model: `${HARMONIQS_PROVIDER_ID}/${HARMONIQS_MODEL_ID}`,
    provider: {
      ...providers,
      [HARMONIQS_PROVIDER_ID]: {
        ...current,
        npm: "@ai-sdk/openai-compatible",
        name: "Harmoniqs AI",
        options: { baseURL: HARMONIQS_BASE_URL },
        models: {
          ...((current.models ?? {}) as Record<string, unknown>),
          [HARMONIQS_MODEL_ID]: model,
        },
      },
    },
  };
  writeFileSync(opts.configPath, JSON.stringify(next, null, 2) + "\n");

  mkdirSync(join(opts.authPath, ".."), { recursive: true });
  let auth: Record<string, unknown> = {};
  try {
    if (existsSync(opts.authPath)) auth = JSON.parse(readFileSync(opts.authPath, "utf8"));
  } catch {
    auth = {};
  }
  writeFileSync(opts.authPath, JSON.stringify({ ...auth, [HARMONIQS_PROVIDER_ID]: { type: "api", key } }, null, 2) + "\n");
  chmodSync(opts.authPath, 0o600);
}

/** Read a key without echoing it. A piped line is used when this is not a terminal. */
export function promptApiKey(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stderr): Promise<string> {
  const stdin = input as NodeJS.ReadStream;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = createInterface({ input, output });
      let got = false;
      rl.once("line", (line) => {
        got = true;
        rl.close();
        resolve(line.trim());
      });
      rl.once("close", () => {
        if (!got) resolve("");
      });
    });
  }
  return new Promise((resolve) => {
    output.write("Harmoniqs API key: ");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (ch: string) => {
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        output.write("\n");
        resolve(buf.trim());
        return;
      }
      if (ch === "\u0003") {
        stdin.setRawMode(false);
        output.write("\n");
        process.exit(130);
      }
      if (ch === "\u007f" || ch === "\b") {
        buf = buf.slice(0, -1);
        return;
      }
      buf += ch;
    };
    stdin.on("data", onData);
  });
}

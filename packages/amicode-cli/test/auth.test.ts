import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";

describe("amicode auth", () => {
  it("execs the vendored binary with auth login and returns its exit code", async () => {
    const asset = mkdtempSync(join(tmpdir(), "amicode-cli-auth-"));
    const receipt = join(asset, "receipt.json");
    const binary = join(asset, "vendor", "opencode", `${process.platform}-${process.arch}`, "opencode");
    mkdirSync(join(binary, ".."), { recursive: true });
    writeFileSync(
      binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.AMICODE_LAUNCH_RECEIPT, JSON.stringify({ argv: process.argv.slice(2) }));
process.exit(0);
`,
    );
    chmodSync(binary, 0o755);
    const result = await run(["auth"], {
      ...process.env,
      AMICODE_ASSET_ROOT: asset,
      AMICODE_LAUNCH_RECEIPT: receipt,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ argv: ["auth", "login"] });
  });

  it("writes the harmoniqs provider and stores the key outside opencode.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "amicode-cli-hq-"));
    const key = "hqa_test_key_value";
    const result = await run(["auth", "harmoniqs"], {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      AMICODE_HARMONIQS_API_KEY: key,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(key);
    const config = JSON.parse(readFileSync(join(home, "config", "opencode", "opencode.json"), "utf8"));
    expect(config.model).toBe("harmoniqs/harmoniqs-auto");
    expect(config.provider.harmoniqs.options.baseURL).toBe("https://app.harmoniqs.ai/v1");
    expect(config.provider.harmoniqs.models["harmoniqs-auto"].tool_call).toBe(true);
    expect(JSON.stringify(config)).not.toContain(key);
    const auth = JSON.parse(readFileSync(join(home, "data", "opencode", "auth.json"), "utf8"));
    expect(auth.harmoniqs).toEqual({ type: "api", key });
    expect(statSync(join(home, "data", "opencode", "auth.json")).mode & 0o777).toBe(0o600);
  });

  it("rejects an unexpected argument after harmoniqs instead of silently ignoring it", async () => {
    const home = mkdtempSync(join(tmpdir(), "amicode-cli-hq-"));
    const result = await run(["auth", "harmoniqs", "garbage"], {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
    });
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("unexpected argument");
    expect(existsSync(join(home, "config", "opencode", "opencode.json"))).toBe(false);
  });

  it("accepts the key via --key without prompting or touching the env var", async () => {
    const home = mkdtempSync(join(tmpdir(), "amicode-cli-hq-"));
    const key = "hqa_from_flag_value";
    const result = await run(["auth", "harmoniqs", "--key", key], {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(key);
    const auth = JSON.parse(readFileSync(join(home, "data", "opencode", "auth.json"), "utf8"));
    expect(auth.harmoniqs).toEqual({ type: "api", key });
  });

  it("--key wins over AMICODE_HARMONIQS_API_KEY when both are given", async () => {
    const home = mkdtempSync(join(tmpdir(), "amicode-cli-hq-"));
    const flagKey = "hqa_flag_wins_value";
    const result = await run(["auth", "harmoniqs", "--key", flagKey], {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      AMICODE_HARMONIQS_API_KEY: "hqa_env_should_lose_value",
    });
    expect(result.code).toBe(0);
    const auth = JSON.parse(readFileSync(join(home, "data", "opencode", "auth.json"), "utf8"));
    expect(auth.harmoniqs).toEqual({ type: "api", key: flagKey });
  });

  it("rejects --key with no value", async () => {
    const home = mkdtempSync(join(tmpdir(), "amicode-cli-hq-"));
    const result = await run(["auth", "harmoniqs", "--key"], {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
    });
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("--key requires a value");
    expect(existsSync(join(home, "config", "opencode", "opencode.json"))).toBe(false);
  });

  it("keeps other providers and refuses a placeholder key", async () => {
    const home = mkdtempSync(join(tmpdir(), "amicode-cli-hq-"));
    const configDir = join(home, "config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "opencode.json"),
      JSON.stringify({
        provider: {
          anthropic: { options: { apiKey: "sk-anthropic-real" } },
          harmoniqs: { models: { other: { name: "kept" } } },
        },
      }),
    );
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
    };
    const bad = await run(["auth", "harmoniqs"], { ...env, AMICODE_HARMONIQS_API_KEY: "sk-test" });
    expect(bad.code).toBe(64);
    const kept = JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf8"));
    expect(kept.provider.anthropic.options.apiKey).toBe("sk-anthropic-real");
    expect(kept.provider.harmoniqs.models.other.name).toBe("kept");

    const good = await run(["auth", "harmoniqs"], { ...env, AMICODE_HARMONIQS_API_KEY: "hqa_real_key_value" });
    expect(good.code).toBe(0);
    const config = JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf8"));
    expect(config.provider.anthropic.options.apiKey).toBe("sk-anthropic-real");
    expect(config.provider.harmoniqs.models.other.name).toBe("kept");
    expect(config.provider.harmoniqs.models["harmoniqs-auto"].limit.output).toBe(4096);
  });
});

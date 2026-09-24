import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const PASSWORD = "sentinel-password-not-for-stdout";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "amicode-cli-env-"));
  const asset = join(root, "extension");
  mkdirSync(join(asset, "opencode-plugin"), { recursive: true });
  mkdirSync(join(asset, "bin", "dist"), { recursive: true });
  mkdirSync(join(asset, "templates"), { recursive: true });
  for (const dir of ["scores", "packs", "skills"]) mkdirSync(join(asset, dir), { recursive: true });
  writeFileSync(join(asset, "AGENTS.md"), "julia {{JULIA_PROJECT}}\n");
  writeFileSync(join(asset, "templates", "solve_template.jl"), "template\n");
  writeFileSync(join(asset, "opencode-plugin", "amicode_context.ts"), "export {}\n");
  writeFileSync(join(asset, "bin", "dist", "mcp-amico.mjs"), "export {}\n");
  const launcher = join(root, "amico-run", "launcher");
  mkdirSync(launcher, { recursive: true });
  for (const name of ["amico", "amico-run"]) {
    const path = join(launcher, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  return asset;
}

describe("amicode env", () => {
  it("sets the spawn keys and prints names only", async () => {
    const asset = fixture();
    const home = mkdtempSync(join(tmpdir(), "amicode-cli-env-home-"));
    const cwd = join(home, "work");
    mkdirSync(cwd);
    const ops = join(home, "ops");
    execFileSync("node", [join(import.meta.dirname, "..", "esbuild.config.mjs")], {
      cwd: join(import.meta.dirname, ".."),
    });
    const prev = {
      HOME: process.env.HOME,
      AMICODE_PROBLEMS_DIR: process.env.AMICODE_PROBLEMS_DIR,
      AMICODE_OPS_DIR: process.env.AMICODE_OPS_DIR,
      AMICO_AUTHORING_FILE: process.env.AMICO_AUTHORING_FILE,
      AMICO_PROFILE_FILE: process.env.AMICO_PROFILE_FILE,
    };
    Object.assign(process.env, {
      HOME: home,
      AMICODE_PROBLEMS_DIR: join(home, "problems"),
      AMICODE_OPS_DIR: ops,
      AMICO_AUTHORING_FILE: join(home, "authoring.json"),
      AMICO_PROFILE_FILE: join(home, "profile.json"),
    });
    try {
      const { describeSpawnEnv } = require(join(import.meta.dirname, "..", "dist", "amicode.cjs")) as {
        describeSpawnEnv: (opts: {
          assetRoot: string;
          cwd: string;
          home: string;
          password: string;
          env: NodeJS.ProcessEnv;
        }) => Promise<{ env: Record<string, string>; listing: string }>;
      };
      const { env, listing } = await describeSpawnEnv({
        assetRoot: asset,
        cwd,
        home,
        password: PASSWORD,
        env: process.env,
      });
      expect(env.PATH.startsWith(join(asset, "..", "amico-run", "launcher"))).toBe(true);
      expect(env.OPENCODE_CONFIG_CONTENT).toContain('"default_agent":"plan"');
      expect(env.OPENCODE_SERVER_PASSWORD).toBe(PASSWORD);
      expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("true");
      expect(env.MPLBACKEND).toBe("Agg");
      expect(listing).toContain("PATH\n");
      expect(listing).toContain("OPENCODE_CONFIG_CONTENT\n");
      expect(listing).toContain("OPENCODE_SERVER_PASSWORD\n");
      expect(listing).not.toContain(PASSWORD);
      expect(listing).not.toContain("{");
      for (const line of listing.split("\n").filter(Boolean)) {
        expect(line).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      }
      const setup = JSON.parse(readFileSync(join(ops, "setup-state.json"), "utf8")) as { julia: { ready: boolean } };
      expect(typeof setup.julia.ready).toBe("boolean");
      expect(existsSync(join(ops, "setup-state.json"))).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

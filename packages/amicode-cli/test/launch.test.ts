import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

function fixture(): { asset: string; binary: string } {
  const root = mkdtempSync(join(tmpdir(), "amicode-cli-tui-"));
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
  const binary = join(asset, "vendor", "opencode", `${process.platform}-${process.arch}`, "opencode");
  mkdirSync(join(binary, ".."), { recursive: true });
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.AMICODE_LAUNCH_RECEIPT, JSON.stringify({
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  pathStartsWithLauncher: (process.env.PATH || "").split(":").includes(${JSON.stringify(launcher)}),
  plan: (process.env.OPENCODE_CONFIG_CONTENT || "").includes('"default_agent":"plan"'),
  externalSkills: process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS || "",
  passwordSet: Boolean(process.env.OPENCODE_SERVER_PASSWORD),
}));
process.exit(Number(process.env.AMICODE_LAUNCH_EXIT || "0"));
`,
  );
  chmodSync(binary, 0o755);
  return { asset, binary };
}

describe("amicode TUI", () => {
  it("execs the vendored binary in the foreground with the spawn env and no args", async () => {
    const { asset } = fixture();
    const home = mkdtempSync(join(tmpdir(), "amicode-cli-tui-home-"));
    const cwd = join(home, "work");
    mkdirSync(cwd);
    const receipt = join(home, "receipt.json");
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
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      AMICODE_ASSET_ROOT: asset,
      AMICODE_PROBLEMS_DIR: join(home, "problems"),
      AMICODE_OPS_DIR: join(home, "ops"),
      AMICO_AUTHORING_FILE: join(home, "authoring.json"),
      AMICO_PROFILE_FILE: join(home, "profile.json"),
      AMICODE_LAUNCH_RECEIPT: receipt,
      AMICODE_LAUNCH_EXIT: "0",
    };
    Object.assign(process.env, childEnv);
    try {
      const { run } = require(join(import.meta.dirname, "..", "dist", "amicode.cjs")) as {
        run: (argv: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
      };
      const result = await run([], childEnv, cwd);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      const recorded = JSON.parse(readFileSync(receipt, "utf8")) as {
        cwd: string;
        argv: string[];
        pathStartsWithLauncher: boolean;
        plan: boolean;
        externalSkills: string;
        passwordSet: boolean;
      };
      expect(recorded.cwd).toBe(cwd);
      expect(recorded.argv).toEqual([]);
      expect(recorded.pathStartsWithLauncher).toBe(true);
      expect(recorded.plan).toBe(true);
      expect(recorded.externalSkills).toBe("true");
      expect(recorded.passwordSet).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

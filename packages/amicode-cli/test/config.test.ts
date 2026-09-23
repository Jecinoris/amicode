import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { projectDirForCwd, readCliSettings } from "../src/settings.js";

function fixture(): string {
  const asset = mkdtempSync(join(tmpdir(), "amicode-cli-assets-"));
  mkdirSync(join(asset, "opencode-plugin"), { recursive: true });
  mkdirSync(join(asset, "bin", "dist"), { recursive: true });
  mkdirSync(join(asset, "templates"), { recursive: true });
  mkdirSync(join(asset, "scores"), { recursive: true });
  mkdirSync(join(asset, "packs"), { recursive: true });
  mkdirSync(join(asset, "skills"), { recursive: true });
  writeFileSync(join(asset, "AGENTS.md"), "julia {{JULIA_PROJECT}}\ntemplate {{TEMPLATE_PATH}}\n");
  writeFileSync(join(asset, "templates", "solve_template.jl"), "template\n");
  writeFileSync(join(asset, "opencode-plugin", "amicode_context.ts"), "export {}\n");
  writeFileSync(join(asset, "bin", "dist", "mcp-amico.mjs"), "export {}\n");
  return asset;
}

function isolatedHome(): string {
  return mkdtempSync(join(tmpdir(), "amicode-cli-home-"));
}

describe("readCliSettings", () => {
  it("treats a missing file as unset defaults", () => {
    expect(readCliSettings(join(tmpdir(), "does-not-exist-cli.json"))).toEqual({
      juliaProject: undefined,
      vaultDir: undefined,
      skillRoots: undefined,
      defaultModel: undefined,
    });
  });

  it("ignores blank fields and keeps a model pin", () => {
    const home = isolatedHome();
    const file = join(home, "cli.json");
    writeFileSync(file, JSON.stringify({ juliaProject: "  ", defaultModel: "openai/gpt", skillRoots: ["", "/pkgs"] }));
    expect(readCliSettings(file)).toEqual({
      juliaProject: undefined,
      vaultDir: undefined,
      skillRoots: ["/pkgs"],
      defaultModel: "openai/gpt",
    });
  });

  it("hashes the working directory into a stable project dir", () => {
    const home = isolatedHome();
    expect(projectDirForCwd("/work/demo", home)).toBe(projectDirForCwd("/work/demo", home));
    expect(projectDirForCwd("/work/demo", home)).not.toBe(projectDirForCwd("/work/other", home));
  });
});

describe("amicode config", () => {
  it("prints JSON whose plugin and MCP paths exist and opens on plan", () => {
    const asset = fixture();
    const home = isolatedHome();
    const cwd = join(home, "work");
    mkdirSync(cwd);
    mkdirSync(join(home, ".amico"), { recursive: true });
    writeFileSync(join(home, ".amico", "cli.json"), JSON.stringify({ defaultModel: "openai/gpt", juliaProject: "" }));
    execFileSync("node", [join(import.meta.dirname, "..", "esbuild.config.mjs")], {
      cwd: join(import.meta.dirname, ".."),
    });
    const stdout = execFileSync(join(import.meta.dirname, "..", "launcher", "amicode"), ["config"], {
      encoding: "utf8",
      cwd,
      env: {
        ...process.env,
        HOME: home,
        AMICODE_ASSET_ROOT: asset,
        AMICODE_PROBLEMS_DIR: join(home, "problems"),
        AMICODE_OPS_DIR: join(home, "ops"),
        AMICO_AUTHORING_FILE: join(home, "authoring.json"),
        AMICO_PROFILE_FILE: join(home, "profile.json"),
      },
    });
    const cfg = JSON.parse(stdout);
    const plugin = join(asset, "opencode-plugin", "amicode_context.ts");
    const mcp = join(asset, "bin", "dist", "mcp-amico.mjs");
    expect(cfg.default_agent).toBe("plan");
    expect(cfg.model).toBe("openai/gpt");
    expect(cfg.plugin).toEqual([plugin]);
    expect(cfg.mcp.amicode.type).toBe("local");
    expect(cfg.mcp.amicode.command).toEqual(["node", mcp]);
    expect(cfg.instructions).toEqual([join(projectDirForCwd(cwd, home), "AGENTS.md")]);
    expect(existsSync(cfg.instructions[0])).toBe(true);
    expect(existsSync(plugin)).toBe(true);
    expect(existsSync(mcp)).toBe(true);
  });

  it("exits 64 when cli.json is not an object", async () => {
    const home = isolatedHome();
    mkdirSync(join(home, ".amico"), { recursive: true });
    writeFileSync(join(home, ".amico", "cli.json"), "[]");
    const result = await run(["config"], { ...process.env, HOME: home });
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("must be a JSON object");
    expect(result.stdout).toBe("");
  });
});

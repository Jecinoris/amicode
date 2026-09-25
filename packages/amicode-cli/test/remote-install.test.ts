import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "..", "remote-install.sh");

function archive(): string {
  const root = mkdtempSync(join(tmpdir(), "amicode-cli-pack-"));
  const tree = join(root, "tree");
  mkdirSync(join(tree, "bin"), { recursive: true });
  mkdirSync(join(tree, "julia"), { recursive: true });
  writeFileSync(join(tree, "VERSION"), "0.1.0\n");
  writeFileSync(join(tree, "bin", "amicode"), "#!/bin/sh\necho amicode\n");
  chmodSync(join(tree, "bin", "amicode"), 0o755);
  writeFileSync(join(tree, "julia", "Project.toml"), "project\n");
  writeFileSync(join(tree, "julia", "Manifest.toml"), "manifest\n");
  const file = join(root, "amicode.tar.gz");
  execFileSync("tar", ["-C", tree, "-czf", file, "."]);
  return file;
}

describe("amicode remote install", () => {
  it("installs a packed tree without a git checkout and without compiling Julia", () => {
    const source = readFileSync(script, "utf8");
    expect(source).not.toContain("Pkg.instantiate");
    expect(source).toContain("curl -fsSL");

    const home = mkdtempSync(join(tmpdir(), "amicode-cli-remote-"));
    const prefix = join(home, ".local");
    const juliaDir = join(home, ".amico", "julia");
    execFileSync("bash", [script, "--archive", archive(), "--prefix", prefix, "--julia-dir", juliaDir]);
    execFileSync("bash", [script, "--archive", archive(), "--prefix", prefix, "--julia-dir", juliaDir]);

    const tree = join(prefix, "share", "amicode", "0.1.0");
    expect(readlinkSync(join(prefix, "bin", "amicode"))).toBe(join(tree, "bin", "amicode"));
    expect(readFileSync(join(juliaDir, "Project.toml"), "utf8")).toBe("project\n");
    expect(existsSync(join(tree, "VERSION"))).toBe(true);
  });
});

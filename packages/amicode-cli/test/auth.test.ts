import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
});

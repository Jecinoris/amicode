import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// #1049 F-harness — AC5/AC6 guard: the harness is plain test-tree fixture
// code. Its modules may import node: builtins and vitest ONLY — no third-party
// dependency, no runtime (src/**) import (constraint: test-tree only, node:net
// / node:timers / node:events first). If a future harness module reaches for a
// package or reaches into the extension runtime, this fails before review.
// ============================================================================

const HARNESS_DIR = join(__dirname, "fixtures/fleet_fault_harness");

const ALLOWED_PREFIXES = ["node:", "vitest"];

describe("fleet_fault_harness — dependency + scope guard (AC6)", () => {
  const modules = readdirSync(HARNESS_DIR).filter((f) => f.endsWith(".ts"));

  it("the harness directory contains the F-harness modules", () => {
    expect(modules).toEqual(expect.arrayContaining(["test_clock.ts", "fault_proxy.ts", "kill_hook.ts"]));
  });

  it.each(modules)("imports nothing outside node: builtins and vitest — %s", (file) => {
    const source = readFileSync(join(HARNESS_DIR, file), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) {
      expect(ALLOWED_PREFIXES.some((p) => spec.startsWith(p))).toBe(true);
    }
    // no runtime reach-in: the harness is test-tree only
    expect(source).not.toMatch(/from\s+["']\.\.\/\.\.\/\.\.\/src\//);
  });
});

import { describe, expect, test } from "vitest";
import { resolveLatexTarget } from "../src/latex_compile";

// #1253: the compile bridge must run latexmk in the .tex file's own directory,
// and must refuse anything outside the workspace/session roots (the parked
// prototype resolved against workspace-folder-0 and used a shell string —
// both wrong). These are the security-critical decisions, kept pure.

describe("resolveLatexTarget", () => {
  const roots = ["/repo", "/other/work"];

  test("accepts a .tex inside a root and derives dir/base/pdf", () => {
    expect(resolveLatexTarget("/repo/paper/main.tex", roots)).toEqual({
      ok: true,
      dir: "/repo/paper",
      base: "main.tex",
      pdf: "/repo/paper/main.pdf",
    });
  });

  test("accepts .ltx too", () => {
    const r = resolveLatexTarget("/repo/a.ltx", roots);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pdf).toBe("/repo/a.pdf");
  });

  test("accepts a file in a second root", () => {
    const r = resolveLatexTarget("/other/work/thesis/ch1.tex", roots);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dir).toBe("/other/work/thesis");
  });

  test("rejects a non-tex extension", () => {
    const r = resolveLatexTarget("/repo/main.md", roots);
    expect(r.ok).toBe(false);
  });

  test("rejects a relative path (no guessing a root)", () => {
    const r = resolveLatexTarget("paper/main.tex", roots);
    expect(r.ok).toBe(false);
  });

  test("rejects a path outside every root", () => {
    const r = resolveLatexTarget("/etc/passwd.tex", roots);
    expect(r.ok).toBe(false);
  });

  test("rejects a traversal escape out of a root", () => {
    const r = resolveLatexTarget("/repo/../etc/evil.tex", roots);
    expect(r.ok).toBe(false);
  });

  test("rejects when there are no roots", () => {
    const r = resolveLatexTarget("/repo/main.tex", []);
    expect(r.ok).toBe(false);
  });
});

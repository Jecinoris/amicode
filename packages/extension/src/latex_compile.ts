// latex_compile — pure target resolution for the LaTeX compile bridge (#1253).
//
// The compile bridge runs `latexmk` in a saved .tex file's OWN directory, and
// must refuse any path outside the workspace/session roots. That containment
// decision — plus deriving the companion .pdf path — is kept here, pure and
// unit-tested, away from the child_process/vscode wiring in chat_bridge.ts.

import * as path from "node:path";

export type LatexTarget =
  | { ok: true; dir: string; base: string; pdf: string }
  | { ok: false; reason: "not-tex" | "not-absolute" | "not-contained" };

/** Is `file` inside `root` (or equal to it), without a `..` escape? */
function contained(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve a save-triggered compile target. Accepts only an absolute `.tex`/
 * `.ltx` path contained in one of `roots`; returns its directory (the compile
 * cwd), basename (the latexmk argument), and companion `.pdf` path.
 */
export function resolveLatexTarget(file: string, roots: readonly string[]): LatexTarget {
  if (!/\.(tex|ltx)$/i.test(file)) return { ok: false, reason: "not-tex" };
  if (!path.isAbsolute(file)) return { ok: false, reason: "not-absolute" };
  const normalized = path.normalize(file);
  if (!roots.some((root) => contained(path.normalize(root), normalized))) {
    return { ok: false, reason: "not-contained" };
  }
  const dir = path.dirname(normalized);
  const base = path.basename(normalized);
  const pdf = path.join(dir, base.replace(/\.(tex|ltx)$/i, ".pdf"));
  return { ok: true, dir, base, pdf };
}

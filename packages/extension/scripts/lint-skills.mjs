#!/usr/bin/env node
// Skills-integrity lint (amicode#1045) — the standing teeth for the skill-
// integrity loop (spec-20260913-skill-integrity-loop). Deterministic, zero-dep,
// no network. Catches, forever, what the 2026-09-13 deep pass fixed once:
//
//   amico-plugin  retired `amico-plugin:*` skill namespace (finding F09)
//   companion     companion file referenced from a SKILL.md does not exist
//                 (conservative: markdown-link `.md` targets, and backticked
//                 paths containing `/`, resolved inside the skill's own dir;
//                 absolute paths, `..` escapes, URLs, and placeholder
//                 templates (`<...>`, `{...}`, `*`) are not resolved)
//   name          frontmatter `name:` ≠ the skill's directory name
//   surface       frontmatter `surface:` not in {public, internal, entitled}
//   agents        unknown `agents:` value — WARNING only (the ontology sweep
//                 is a later slice); warnings never fail the lint
//
//   node scripts/lint-skills.mjs [--dir <skills-root>] [--known <file>] [--json]
//
//   --dir    skills library root (default: this repo's source tree,
//            packages/extension/skills)
//   --known  escape hatch: a file of `path:rule` exemption lines (path
//            relative to the skills root, e.g. `code-review/SKILL.md:amico-plugin`),
//            one per line, `#` comments and blank lines ok. An optional
//            third `:ref` segment narrows a companion exemption to exactly
//            that referenced path (`skill/SKILL.md:companion:guide.md`) —
//            unlisted occurrences in the same file still fail. Listed
//            occurrences are reported as known-warnings, never errors.
//   --json   machine-readable report on stdout (the dream-side pass consumes
//            this; findings land in the vault ledger)
//
// Exit codes (same contract as scripts/skill_drift_lint.mts):
//   0  clean (warnings and known-warnings allowed)
//   1  errors found (each listed with file + line)
//   2  usage / pre-flight — bad args, missing --dir, or the deployed-copy
//      guard: a --dir containing "workspaceStorage" is REFUSED outright.
//      That tree is a build artifact, never a source (spec invariant O1) —
//      lint it and you'd bless a deployed copy.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(SCRIPT_DIR, "..", "skills");

const AGENT_VALUES = new Set([
  "researcher", "experimenter", "librarian", "hypothesizer", "analyzer",
  "implementer", "director", "dreamer", "dispatcher", "orchestrator",
  "engineer", "pulse-designer",
]);
const SURFACE_VALUES = new Set(["public", "internal", "entitled"]);
const RULES = ["amico-plugin", "companion", "name", "surface"];

const USAGE = `usage: node scripts/lint-skills.mjs [--dir <skills-root>] [--known <file>] [--json]`;

function fail(msg) {
  console.error(`lint-skills: ${msg}\n${USAGE}`);
  return 2;
}

function parseArgs(argv) {
  const out = { dir: DEFAULT_DIR, known: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--json") out.json = true;
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--known") out.known = argv[++i];
    else if (a.startsWith("--")) return { error: `unknown flag ${a}` };
    else return { error: `unexpected argument ${a}` };
  }
  if (out.dir === undefined || out.known === undefined) return { error: "missing value for flag" };
  return out;
}

// A `path:rule[:ref]` exemption set. Unknown rule names are ignored so a
// typo can never silently widen the exemption (a typo'd rule matches nothing).
function loadKnown(file) {
  const set = new Set();
  if (!file) return set;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { error: `cannot read --known file: ${e.message}` };
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(":");
    if (parts.length < 2) continue;
    const rule = parts[1];
    if (!RULES.includes(rule)) continue;
    if (parts.length === 2) set.add(`${parts[0]}:${rule}`);
    else if (parts.length === 3 && parts[2]) set.add(`${parts[0]}:${rule}:${parts[2]}`);
  }
  return set;
}

// Conservative companion-path collection: markdown-link targets ending in
// `.md` (any shape), plus backticked paths ending in `.md` that carry a `/`.
// Everything that smells like a template, an external path, or an escape is
// skipped — false negatives are fine, false positives would drown the signal
// (the known list exists for the residue, not as a dumping ground).
function collectCompanionRefs(text) {
  const refs = [];
  const seen = (ref, pos, kind) => refs.push({ ref, line: text.slice(0, pos).split("\n").length, kind });
  const linkRe = /\[[^\]]*\]\(([^)\n]+)\)/g;
  let m;
  while ((m = linkRe.exec(text))) seen(m[1].trim(), m.index, "link");
  const tickRe = /`([^`\n]+)`/g;
  while ((m = tickRe.exec(text))) {
    const ref = m[1].trim();
    if (ref.endsWith(".md") && ref.includes("/")) seen(ref, m.index, "backtick");
  }
  return refs;
}

function isResolvable(ref) {
  if (!ref || ref.length === 0) return false;
  if (ref.endsWith(".md") === false) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return false; // scheme: https:, mailto:, ...
  if (ref.startsWith("/")) return false; // absolute
  if (ref.includes("..")) return false; // escape / range
  if (/[<>{}*]/.test(ref)) return false; // placeholder template
  if (ref.includes("#")) return false; // anchor
  return true;
}

function lintSkill(skillDir, relDir) {
  const findings = [];
  const file = path.join(skillDir, "SKILL.md");
  const rel = relDir ? path.join(relDir, "SKILL.md") : "SKILL.md";
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    findings.push({ rel, line: 0, rule: "companion", severity: "error", msg: "SKILL.md unreadable" });
    return findings;
  }
  const lines = text.split("\n");

  // (1) retired namespace — anywhere in the file
  lines.forEach((line, idx) => {
    if (line.includes("amico-plugin:")) {
      findings.push({ rel, line: idx + 1, rule: "amico-plugin", severity: "error", msg: "retired `amico-plugin:` skill namespace" });
    }
  });

  // (2) frontmatter (between the first two `---` lines)
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      for (let i = 1; i < end; i++) {
        const m = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/);
        if (!m) continue;
        const [, key, value] = m;
        if (key === "name" && value && value !== path.basename(skillDir)) {
          findings.push({ rel, line: i + 1, rule: "name", severity: "error", msg: `frontmatter name \`${value}\` ≠ directory \`${path.basename(skillDir)}\`` });
        }
        if (key === "surface" && value && !SURFACE_VALUES.has(value)) {
          findings.push({ rel, line: i + 1, rule: "surface", severity: "error", msg: `surface \`${value}\` not in {public, internal, entitled}` });
        }
        if (key === "agents") {
          const vals = value.replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
          for (const a of vals) {
            if (!AGENT_VALUES.has(a)) {
              findings.push({ rel, line: i + 1, rule: "agents", severity: "warning", msg: `unknown agents value \`${a}\` (ontology sweep is a later slice)` });
            }
          }
        }
      }
    }
  }

  // (3) dead companion files — resolve inside the skill's own directory only
  for (const { ref, line } of collectCompanionRefs(text)) {
    const cleaned = ref.replace(/^\.\//, "").split("#")[0].trim();
    if (!isResolvable(cleaned)) continue;
    const target = path.join(skillDir, cleaned);
    // defense in depth: the resolution must stay inside the skill dir
    if (!path.resolve(target).startsWith(path.resolve(skillDir) + path.sep)) continue;
    if (!fs.existsSync(target)) {
      findings.push({ rel, line, rule: "companion", severity: "error", ref: cleaned, msg: `companion file \`${ref}\` does not exist` });
    }
  }
  return findings;
}

function lintDir(root) {
  const findings = [];
  let skills = 0;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isDirectory()) continue;
    const skillMd = path.join(root, ent.name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue; // not a skill dir
    skills++;
    findings.push(...lintSkill(path.join(root, ent.name), ent.name));
  }
  return { findings, skills };
}

function isKnownFinding(knownSet, f) {
  if (knownSet.has(`${f.rel}:${f.rule}`)) return true;
  if (f.ref && knownSet.has(`${f.rel}:${f.rule}:${f.ref}`)) return true;
  return false;
}

function render(findings, knownSet) {
  const out = [];
  for (const f of findings) {
    const isKnown = isKnownFinding(knownSet, f);
    const sev = f.severity === "error" && !isKnown ? "error" : "warning";
    const tag = isKnown ? "known" : sev;
    out.push(`${f.rel}:${f.line}: [${f.rule}] ${tag}: ${f.msg}`);
  }
  return out;
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) { console.log(USAGE); return 0; }
  if (parsed.error) return fail(parsed.error);

  // spec O1 — the deployed copy is a build artifact, never a lint target.
  if (parsed.dir.includes("workspaceStorage")) {
    console.error(`lint-skills: refusing ${parsed.dir} — this is a deployed workspaceStorage copy (a build artifact); lint source roots only (packages/extension/skills, armonissima/skills), never the deployed copy (spec invariant O1)`);
    return 2;
  }
  if (!fs.statSync(parsed.dir, { throwIfNoEntry: false })?.isDirectory()) {
    return fail(`skills dir not found: ${parsed.dir}`);
  }
  const known = loadKnown(parsed.known);
  if (known.error) return fail(known.error);

  const { findings, skills } = lintDir(parsed.dir);
  const lines = render(findings, known);
  const errors = lines.filter((l) => l.includes(" error: ")).length;
  const warnings = lines.filter((l) => l.includes(" warning: ")).length;

  if (parsed.json) {
    console.log(JSON.stringify({
      ok: errors === 0,
      skills,
      errors,
      warnings,
      findings: findings.map((f) => ({
        file: f.rel, line: f.line, rule: f.rule, severity: f.severity,
        known: isKnownFinding(known, f), ref: f.ref, msg: f.msg,
      })),
    }, null, 2));
  } else if (lines.length) {
    for (const l of lines) console.log(l);
  }
  console.error(`lint-skills: ${skills} skills, ${errors} error(s), ${warnings} warning(s)${errors ? " — FAIL" : " — ok"}`);
  return errors > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}

export { main, lintDir, lintSkill, collectCompanionRefs, isResolvable, loadKnown };

// Skills-integrity lint (#1045) — the standing teeth for the skill-integrity
// loop (spec-20260913-skill-integrity-loop, spec O1). Exercises the CLI
// end-to-end: retired `amico-plugin:` namespace, dead companion-file refs,
// frontmatter drift, the deployed-copy (workspaceStorage) refusal, and the
// `--known` escape hatch that lets today's tree pass while new occurrences
// fail.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(EXT_ROOT, "scripts", "lint-skills.mjs");
const REAL_SKILLS = join(EXT_ROOT, "skills");
const KNOWN_FILE = join(EXT_ROOT, "scripts", "lint-skills-known.txt");

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function makeSkill(dir: string, name: string, body: string, frontmatter?: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const fm = frontmatter ?? `---\nname: ${name}\ndescription: test skill\nsurface: public\n---\n`;
  writeFileSync(join(skillDir, "SKILL.md"), fm + "\n" + body + "\n");
}

function makeFixtureTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-integrity-"));
  // clean skill
  makeSkill(dir, "clean-skill", "Does the thing. See `references/guide.md` and [notes](notes.md).");
  mkdirSync(join(dir, "clean-skill", "references"), { recursive: true });
  writeFileSync(join(dir, "clean-skill", "references", "guide.md"), "guide\n");
  writeFileSync(join(dir, "clean-skill", "notes.md"), "notes\n");
  // retired namespace
  makeSkill(dir, "ns-skill", "Dispatches the `amico-plugin:code-reviewer` subagent.");
  // dead companions: backticked subdir path + bare markdown link
  makeSkill(dir, "dead-path-skill", "Read [the guide](guide.md) and `tdd/tests.md` first.");
  // frontmatter drift
  makeSkill(dir, "drift-skill", "Body.", "---\nname: not-drift-skill\ndescription: x\nsurface: secret\n---\n");
  // unknown agent value → WARNING, not an error
  makeSkill(dir, "agent-skill", "Body.", "---\nname: agent-skill\ndescription: x\nsurface: public\nagents: [wizard]\n---\n");
  return dir;
}

describe("skills-integrity lint CLI (#1045)", () => {
  it("flags retired amico-plugin: namespace, dead companions, and frontmatter drift; warns on unknown agents", () => {
    const dir = makeFixtureTree();
    try {
      const r = run(["--dir", dir]);
      expect(r.status).toBe(1);
      const out = r.stdout + r.stderr;
      // errors carry file + line
      expect(out).toMatch(/ns-skill\/SKILL\.md:\d+:.*amico-plugin/);
      expect(out).toMatch(/dead-path-skill\/SKILL\.md:\d+:.*companion/);
      expect(out).toMatch(/drift-skill\/SKILL\.md:\d+:.*(name|surface)/);
      // unknown agent is a warning, not an error — still listed, but the exit
      // is driven by the errors above
      expect(out).toMatch(/agent-skill\/SKILL\.md:\d+:.*agents.*warning/i);
      // clean skill contributes nothing
      expect(out).not.toMatch(/clean-skill\/SKILL\.md:\d+:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 on a tree whose only problems are warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-integrity-warn-"));
    try {
      makeSkill(dir, "agent-skill", "Body.", "---\nname: agent-skill\ndescription: x\nsurface: public\nagents: [wizard]\n---\n");
      const r = run(["--dir", dir]);
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toMatch(/agents.*warning/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--known exemptions let listed occurrences pass, but NOT unlisted ones", () => {
    const dir = makeFixtureTree();
    try {
      // exempt ns-skill's namespace hit only — the rest still fail
      const known = join(dir, "known.txt");
      writeFileSync(known, "# exempted 2026-09-13, F09\nns-skill/SKILL.md:amico-plugin\n");
      const r = run(["--dir", dir, "--known", known]);
      expect(r.status).toBe(1);
      const out = r.stdout + r.stderr;
      expect(out).not.toMatch(/ns-skill\/SKILL\.md:\d+: \[amico-plugin\] error:/);
      expect(out).toMatch(/ns-skill\/SKILL\.md:\d+: \[amico-plugin\] known:/);
      expect(out).toMatch(/dead-path-skill\/SKILL\.md:\d+: \[companion\] error:/);

      // a ref-scoped companion exemption covers exactly that reference —
      // the other dead path in the same file still fails
      writeFileSync(known, "dead-path-skill/SKILL.md:companion:tdd/tests.md\n");
      const r3 = run(["--dir", dir, "--known", known]);
      expect(r3.status).toBe(1);
      expect(r3.stdout + r3.stderr).toMatch(/companion file `guide\.md` does not exist/);
      expect(r3.stdout + r3.stderr).not.toMatch(/\[companion\] error: companion file `tdd\/tests\.md`/);
      expect(r3.stdout + r3.stderr).toMatch(/\[companion\] known: companion file `tdd\/tests\.md`/);

      // exempting every rule the fixture trips → exit 0
      writeFileSync(
        known,
        [
          "ns-skill/SKILL.md:amico-plugin",
          "dead-path-skill/SKILL.md:companion",
          "drift-skill/SKILL.md:name",
          "drift-skill/SKILL.md:surface",
        ].join("\n") + "\n",
      );
      const r2 = run(["--dir", dir, "--known", known]);
      expect(r2.status).toBe(0);
      // an unknown rule name in the known file exempts nothing
      writeFileSync(known, "ns-skill/SKILL.md:amico-plugin-typo\n");
      const r4 = run(["--dir", dir, "--known", known]);
      expect(r4.status).toBe(1);
      expect(r4.stdout + r4.stderr).toMatch(/ns-skill\/SKILL\.md:\d+: \[amico-plugin\] error:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to run against a deployed workspaceStorage copy (spec O1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "workspaceStorage-probe-"));
    try {
      makeSkill(dir, "some-skill", "Body.");
      const r = run(["--dir", dir]);
      expect(r.status).not.toBe(0);
      const out = r.stdout + r.stderr;
      expect(out).toMatch(/workspaceStorage/i);
      expect(out).toMatch(/deployed|build artifact/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is green over the repo's real skills tree with the checked-in known list", () => {
    const r = run(["--dir", REAL_SKILLS, "--known", KNOWN_FILE]);
    if (r.status !== 0) {
      throw new Error(`lint failed over the real tree:\n${r.stdout}\n${r.stderr}`);
    }
    expect(r.status).toBe(0);
  });

  it("errors on a missing --dir (usage, not silent ok)", () => {
    const r = run(["--dir", join(tmpdir(), "does-not-exist-skills-integrity")]);
    expect(r.status).not.toBe(0);
  });
});

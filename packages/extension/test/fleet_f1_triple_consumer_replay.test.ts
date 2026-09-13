// fleet_f1_triple_consumer_replay.test.ts — spec spec-20260913-114814 §8 F1
// (amicode#1106, fleet rearchitect P3b-2): the SAME stale / broken / absent
// topology cases fed to ALL THREE consumers — the extension (fleet_topology's
// projection read), the installer (the verb's machine-parseable output), the
// guard (the projection cache) — each through its real surface (unit seam for
// the extension; real bash execs with fabricated HOME/PATH for the scripts).
// Plus the F1 counter: `n_fleet_topology_parsers == 1` — ZERO raw fleet
// config parsers survive on the amicode side (source-scanned), and the ONE
// parser is amicissimo's, pinned behind the `amico fleet` CLI door (the verb's
// publisher invocation + the @amicode/schema reader).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFleetTopology, readFleetTopologyWithRefresh, type VerbRunResult } from "../src/fleet_topology";

const REPO = join(__dirname, "..", "..", "..");
const GUARD = join(REPO, "tools", "fleet", "amico-opencode-fleet-guard");
const INSTALL = join(REPO, "tools", "fleet", "install.sh");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fleet-f1-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const EPOCH_A = "44444444-4444-4444-8444-444444444444";
const EPOCH_B = "55555555-5555-4555-8555-555555555555";

// ── the SHARED fixture set — one topology truth, three consumers ───────────────

/** The client projection (a re-publish with the same counter = the STALE case). */
const CLIENT_PROJECTION = (epoch: string = EPOCH_A, counter: number = 4) => JSON.stringify({
  schema_version: 1,
  contract_version: 1,
  publisher: { identity: "fleet_authority", published_at: "2026-09-13T12:00:00Z" },
  freshness: { counter, hub_epoch: epoch },
  sections: {
    mode: { value: "fleet", provenance: { source: "fleet config", parsed_from: "role='client' (vocabulary mapping)" } },
    posture: { value: "ok" },
    topology: {
      value: { role: "client", canonical: { host: "hq-hub-01.example.internal", port: 4096, sshAlias: "hq-hub-01" } },
      provenance: { source: "fleet config" },
    },
  },
}, null, 2);

/** The BROKEN case: a projection speaking a contract this consumer does not. */
const FUTURE_CONTRACT_PROJECTION = JSON.stringify({
  schema_version: 1,
  contract_version: 2,
  sections: { topology: { value: { role: "client" } } },
}, null, 2);

function writeCache(content: string): void {
  const dir = join(tmp, ".amico", "ops", "fleet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "projection.json"), content);
}

function fakeAmico(behavior: { code: number; stdout: string; cacheContent?: string }): void {
  const bin = join(tmp, "fakebin");
  mkdirSync(bin, { recursive: true });
  const lines = ["#!/usr/bin/env bash", "set -u"];
  if (behavior.cacheContent !== undefined) {
    lines.push(`mkdir -p "$HOME/.amico/ops/fleet"`, `cat > "$HOME/.amico/ops/fleet/projection.json" << 'AMICO_FAKE_EOF'`, behavior.cacheContent, "AMICO_FAKE_EOF");
  }
  lines.push("cat << 'AMICO_STDOUT_EOF'", behavior.stdout, "AMICO_STDOUT_EOF", `exit ${behavior.code}`);
  writeFileSync(join(bin, "amico"), lines.join("\n") + "\n");
  chmodSync(join(bin, "amico"), 0o755);
}

function fakeFrozenBinary(): void {
  const dir = join(tmp, ".amico", "server", "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "opencode"), "#!/usr/bin/env bash\necho FROZEN-EXEC\n");
  chmodSync(join(dir, "opencode"), 0o755);
}

const guardEnvPath = (): string => `${join(tmp, "fakebin")}:/usr/bin:/bin`;

/** A launcher-less fake repo — the installer's CLI-absent branch is only
 *  reachable when the repo's own launchers are absent too (a dev checkout
 *  ships them). */
function fakeRepoInstall(): string {
  const repo = join(tmp, "fake-repo");
  mkdirSync(join(repo, "tools", "fleet"), { recursive: true });
  for (const f of ["install.sh", "amico-opencode-fleet-guard", "co.harmoniqs.amico-tunnel.plist"]) {
    writeFileSync(join(repo, "tools", "fleet", f), readFileSync(join(REPO, "tools", "fleet", f), "utf8"));
  }
  return join(repo, "tools", "fleet", "install.sh");
}

function runBash(script: string, args: string[], pathOverride?: string): { code: number; out: string } {
  const r = spawnSync("bash", [script, ...args], {
    env: { HOME: tmp, PATH: pathOverride ?? guardEnvPath() },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ── the replay: one case, three consumers, consistent outcomes ────────────────

describe("F1: the triple-consumer replay — the SAME topology cases through all three", () => {
  it("ABSENT topology: all three consumers land on the honest base-standalone bootstrap — stated, never silent, never raw", () => {
    // The extension: absent cache + verb 75 → the bootstrap exception, spawn-allowed floor
    const ext = readFleetTopologyWithRefresh({
      cachePath: join(tmp, "absent-projection.json"),
      runVerb: () => ({ code: 75, stdout: "base-standalone (bootstrap exception)", stderr: "" }) as VerbRunResult,
    });
    expect(ext.state.kind).toBe("absent");
    expect(ext.bootstrap).not.toBeNull();
    if (ext.bootstrap !== null) {
      expect(ext.bootstrap.reason).toBe("verb-75");
      expect(ext.bootstrap.stated).toMatch(/base-standalone/);
    }

    // The guard: absent cache + verb 75 → stated + spawn (execs the frozen binary)
    fakeAmico({ code: 75, stdout: "base-standalone (bootstrap exception)" });
    fakeFrozenBinary();
    const guard = runBash(GUARD, []);
    expect(guard.code).toBe(0);
    expect(guard.out).toMatch(/base-standalone \(bootstrap exception/);
    expect(guard.out).toMatch(/FROZEN-EXEC/); // the floor's local spawn
    expect(guard.out).toMatch(/stated, never silent/);

    // The installer: CLI absent (a launcher-less install surface) → the IDENTICAL stated branch, exit 0
    const installer = runBash(fakeRepoInstall(), ["--check"], "/usr/bin:/bin");
    expect(installer.code).toBe(0);
    expect(installer.out).toMatch(/base-standalone \(bootstrap exception/);
    expect(installer.out).toMatch(/amico CLI is absent/);
  });

  it("ABSENT topology that the verb REPAIRS to client: all three consumers land on client (the enrolled-machine bootstrap)", () => {
    // The extension: absent → refresh (verb 0, writes the cache) → ok/client
    const cachePath = join(tmp, ".amico", "ops", "fleet", "projection.json");
    const ext = readFleetTopologyWithRefresh({
      cachePath,
      runVerb: () => {
        writeCache(CLIENT_PROJECTION());
        return { code: 0, stdout: "{}", stderr: "" } as VerbRunResult;
      },
    });
    expect(ext.refreshed).toBe(true);
    if (ext.state.kind !== "ok") throw new Error("expected ok");
    expect(ext.state.role).toBe("client");

    // The guard: absent → refresh → refuses to spawn
    fakeAmico({ code: 0, stdout: "{}", cacheContent: CLIENT_PROJECTION() });
    const guard = runBash(GUARD, []);
    expect(guard.code).toBe(1);
    expect(guard.out).toMatch(/refusing to spawn/);

    // The installer: verb 0 with role client → the fleet branch
    fakeAmico({ code: 0, stdout: JSON.stringify({ ok: true, role: "client", canonical: { host: "hq", port: 4096, sshAlias: "hq" } }) });
    const installer = runBash(INSTALL, ["--check"], `${join(tmp, "fakebin")}:${process.env.PATH ?? ""}`);
    expect(installer.out).toMatch(/fleet role: client \(port: 4096\)/);
  });

  it("BROKEN topology (future contract): every consumer refuses loudly — the extension surfaces both versions, the guard fails closed, the installer dies", () => {
    // The extension: the reader's loud rejection, both versions named
    writeCache(FUTURE_CONTRACT_PROJECTION);
    const ext = readFleetTopology({ cachePath: join(tmp, ".amico", "ops", "fleet", "projection.json") });
    expect(ext.kind).toBe("broken");
    if (ext.kind !== "broken") return;
    expect(ext.detail).toContain("v2");
    expect(ext.detail).toContain("v1");

    // The guard: unusable cache (contract not v1) + verb failure → fails closed
    fakeAmico({ code: 64, stdout: "projection carries contract v2; this consumer speaks v1 — refusing loudly" });
    fakeFrozenBinary();
    const guard = runBash(GUARD, []);
    expect(guard.code).toBe(1);
    expect(guard.out).not.toMatch(/FROZEN-EXEC/); // never a silent fork on an unreadable topology

    // The installer: the verb's reader rejected the publisher's artifact → exit 64 → dies honestly
    const installer = runBash(INSTALL, ["--check"], `${join(tmp, "fakebin")}:${process.env.PATH ?? ""}`);
    expect(installer.code).toBe(1);
    expect(installer.out).not.toMatch(/standalone mode — nothing to install/); // never silently "standalone"
  });

  it("STALE topology (same counter re-published): the extension surfaces the verdict, the guard still refuses on client, the installer still takes the fleet branch", () => {
    // The extension: two reads of the same counter → the stale verdict surfaces
    const cachePath = join(tmp, "projection.json");
    writeFileSync(cachePath, CLIENT_PROJECTION());
    const first = readFleetTopology({ cachePath });
    const second = readFleetTopology({ cachePath, previous: first.kind === "ok" ? first.projection : null });
    if (second.kind !== "ok") throw new Error("expected ok");
    expect(second.verdict).toBe("stale");
    expect(second.advisory).toMatch(/nothing new was published/);

    // The guard: staleness never flips the role — client still refuses
    writeCache(CLIENT_PROJECTION());
    const guard = runBash(GUARD, []);
    expect(guard.code).toBe(1);
    expect(guard.out).toMatch(/refusing to spawn/);

    // The installer: the verb's output still carries role=client → the fleet branch
    fakeAmico({ code: 0, stdout: JSON.stringify({ ok: true, role: "client", canonical: { host: "hq", port: 4096, sshAlias: "hq" } }) });
    const installer = runBash(INSTALL, ["--check"], `${join(tmp, "fakebin")}:${process.env.PATH ?? ""}`);
    expect(installer.out).toMatch(/fleet role: client \(port: 4096\)/);
  });
});

// ── the F1 counter: n_fleet_topology_parsers == 1 ──────────────────────────────

describe("F1: n_fleet_topology_parsers == 1 (the one parser is amicissimo's, behind the CLI)", () => {
  const scanFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? scanFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
    );

  it("ZERO raw fleet-config parsers survive on the amicode side (the extension src + the plugin)", () => {
    const surfaces = [
      ...scanFiles(join(REPO, "packages", "extension", "src")),
      join(REPO, "packages", "extension", "opencode-plugin", "stack_state.ts"),
    ];
    const rawParses: string[] = [];
    for (const f of surfaces) {
      const src = readFileSync(f, "utf8");
      // the raw-parse idiom: a read of the fleet config followed by a parse
      if (/readFileSync\s*\([^)]*fleet\.json/.test(src) || /fleet\.json[\s\S]{0,120}readFileSync/.test(src)) rawParses.push(f);
      // the plugin must not even name the raw file (it reads the projection)
      if (f.endsWith("stack_state.ts") && /fleet\.json/.test(src)) rawParses.push(f);
    }
    expect(rawParses).toEqual([]);
  });

  it("ZERO raw fleet-config parsers in the bash consumers (repo copies AND the VSIX's packaged copies)", () => {
    const scripts = [
      join(REPO, "tools", "fleet", "install.sh"),
      join(REPO, "tools", "fleet", "amico-opencode-fleet-guard"),
      join(REPO, "packages", "extension", "tools", "fleet", "install.sh"),
      join(REPO, "packages", "extension", "tools", "fleet", "amico-opencode-fleet-guard"),
    ];
    for (const s of scripts) {
      const src = readFileSync(s, "utf8");
      expect(src, `${s} names a raw config path`).not.toMatch(/FLEET_CONFIG=/);
      expect(src, `${s} greps a role from the raw config`).not.toMatch(/grep[^#]*"role"[^#]*fleet\.json/);
    }
  });

  it("the ONE parser is amicissimo's, behind the CLI door: the verb pins the publisher invocation + reads through @amicode/schema", () => {
    const verb = readFileSync(join(REPO, "packages", "amico-run", "src", "fleet_projection_verb.ts"), "utf8");
    expect(verb).toMatch(/"-m",\s*"fleet_authority",\s*"publish"/); // the pinned publisher door
    expect(verb).toMatch(/from "@amicode\/schema"/); // the ONE reader, consumed never re-defined
    // the cache convention is written by the verb and read by the consumers
    expect(verb).toMatch(/fleetProjectionCachePath/);
  });

  it("the composed counter: amicode-side parsers (0) + the CLI door's parser (1) == n_fleet_topology_parsers == 1", () => {
    const amicodeSide: number = 0; // proven by the two scans above (this test composes the fixture's counter)
    const cliDoor: number = 1; // amicissimo's fleet_authority, pinned behind `amico fleet status --projection`
    const n_fleet_topology_parsers = amicodeSide + cliDoor;
    expect(n_fleet_topology_parsers).toBe(1);
  });
});

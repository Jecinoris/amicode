// fleet_topology.test.ts — the extension's fleet-topology read (#1106, fleet
// rearchitect P3b-2, spec spec-20260913-114814 row 1 / D1): the extension
// consumes the ONE fleet projection reader (@amicode/schema fleet_projection)
// over the verb-refreshed cache artifact (<home>/.amico/ops/fleet/projection.json),
// NEVER the raw fleet.json — amicissimo parses and publishes, amicode consumes.
//
// The properties this suite defends:
//   1. THE READER IS THE GATE. Contract validation + base-default discipline
//      come from @amicode/schema verbatim — this module adds no second format.
//   2. ABSENT / BROKEN ARE RENDERED STATES. A missing cache, a future
//      contract_version, a corrupt artifact — each returns a NAMED state with
//      an honest message + pointer, never a silent fallthrough to raw files,
//      never an error dump, never an invented topology.
//   3. THE REFRESH GOES THROUGH THE VERB (the CLI is the only door). Absent
//      or broken cache → `amico fleet status --projection` via an injectable
//      seam; exit 75 = the bootstrap exception (base-standalone stated with
//      the pointer); CLI-absent behaves identically; a verb FAILURE is a
//      distinct honest state, never mislabeled bootstrap.
//   4. FRESHNESS SURFACES (D1). The carried counter/epoch render; a previous
//      projection yields the verdict + advisory (unknown = force refetch +
//      surface — the refresh fires).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readFleetTopology,
  readFleetTopologyWithRefresh,
  FLEET_TOPOLOGY_CACHE_DEFAULT_HINT,
  type VerbRunResult,
} from "../src/fleet_topology";

let tmp: string;
let cachePath: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fleet-topology-"));
  cachePath = join(tmp, "projection.json");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const EPOCH_A = "44444444-4444-4444-8444-444444444444";
const EPOCH_B = "55555555-5555-4555-8555-555555555555";

function writeProjection(over: Record<string, unknown> = {}, p: string = cachePath): void {
  writeFileSync(p, JSON.stringify({
    schema_version: 1,
    contract_version: 1,
    publisher: { identity: "fleet_authority", published_at: "2026-09-13T12:00:00Z" },
    freshness: { counter: 7, hub_epoch: EPOCH_A },
    sections: {
      mode: { value: "fleet", provenance: { source: "fleet.json", parsed_from: "role='client' (vocabulary mapping)" } },
      posture: { value: "ok", provenance: { source: "fleet-status.json", parsed_from: "base default (posture absent = ok)" } },
      topology: {
        value: {
          role: "client",
          canonical: { host: "hq-hub-01.example.internal", port: 4096, sshAlias: "hq-hub-01" },
          previousBinary: "/home/example/.amico/server/bin/opencode",
          previousPort: 4096,
        },
        provenance: { source: "fleet.json", parsed_from: "topology schema v1 fields: role, canonical, previousBinary, previousPort" },
      },
    },
    ...over,
  }, null, 2));
}

/** The mode-only projection: a machine with NO fleet.json — the publisher
 *  carries mode=standalone and no topology section (the base default,
 *  honestly carried, never invented). */
function writeStandaloneProjection(p: string = cachePath): void {
  writeFileSync(p, JSON.stringify({
    schema_version: 1,
    contract_version: 1,
    publisher: { identity: "fleet_authority", published_at: "2026-09-13T12:00:00Z" },
    freshness: { counter: 3, hub_epoch: EPOCH_A },
    sections: { mode: { value: "standalone", provenance: { source: "base default (mode absent = standalone)" } } },
  }, null, 2));
}

// ── the read: through the reader, states for everything else ──────────────────

describe("readFleetTopology — the reader-consumed cache read", () => {
  it("a lawful projection with topology → ok: role + canonical verbatim, provenance + freshness surfaced", () => {
    writeProjection();
    const st = readFleetTopology({ cachePath });
    expect(st.kind).toBe("ok");
    if (st.kind !== "ok") return;
    expect(st.role).toBe("client");
    expect(st.canonical).toMatchObject({ host: "hq-hub-01.example.internal", port: 4096, sshAlias: "hq-hub-01" });
    expect(st.mode).toBe("fleet");
    expect(st.posture).toBe("ok");
    expect(st.freshness.counter).toBe(7);
    expect(String(st.freshness.hubEpoch)).toBe(EPOCH_A);
    expect(st.provenanceSource).toBe("fleet.json"); // provenance renders, metadata beside the value
  });

  it("a projection without a topology section → ok with the base default role (standalone), honestly", () => {
    writeStandaloneProjection();
    const st = readFleetTopology({ cachePath });
    expect(st.kind).toBe("ok");
    if (st.kind !== "ok") return;
    expect(st.role).toBe("standalone");
    expect(st.canonical).toBeUndefined();
    expect(st.mode).toBe("standalone");
  });

  it("absent cache → the NAMED absent state with the bootstrap pointer — never a crash, never silent standalone invention", () => {
    const st = readFleetTopology({ cachePath });
    expect(st.kind).toBe("absent");
    if (st.kind !== "absent") return;
    expect(st.detail).toMatch(/projection/i);
    expect(st.detail).toContain(FLEET_TOPOLOGY_CACHE_DEFAULT_HINT); // the pointer: refresh via the verb
    expect(st.detail).toMatch(/amico fleet status --projection/);
  });

  it("a future contract_version → the broken state carrying the reader's LOUD rejection (both versions named)", () => {
    writeProjection({ contract_version: 2 });
    const st = readFleetTopology({ cachePath });
    expect(st.kind).toBe("broken");
    if (st.kind !== "broken") return;
    expect(st.detail).toContain("v2");
    expect(st.detail).toContain("v1");
    expect(st.detail).toMatch(/refusing loudly/i);
  });

  it("a corrupt artifact (not JSON) → broken, honest, never a crash", () => {
    writeFileSync(cachePath, "{ this is not json");
    const st = readFleetTopology({ cachePath });
    expect(st.kind).toBe("broken");
    if (st.kind !== "broken") return;
    expect(st.detail.length).toBeGreaterThan(0);
  });

  it("an out-of-vocabulary role surfaces verbatim — surfaced, never silently remapped", () => {
    writeProjection({
      sections: {
        topology: { value: { role: "space-station" }, provenance: { source: "fleet.json" } },
      },
    });
    const st = readFleetTopology({ cachePath });
    expect(st.kind).toBe("ok");
    if (st.kind !== "ok") return;
    expect(st.role).toBe("space-station");
  });
});

// ── D1 freshness surfacing ─────────────────────────────────────────────────────

describe("readFleetTopology — freshness surfaces (spec §3 D1)", () => {
  it("no previous → no verdict, carried fields only (never a wall-clock age)", () => {
    writeProjection();
    const st = readFleetTopology({ cachePath });
    expect(st.kind).toBe("ok");
    if (st.kind !== "ok") return;
    expect(st.verdict).toBeUndefined();
    expect(JSON.stringify(st)).not.toMatch(/Date|now\(/i); // no local clock in the state
  });

  it("same counter vs the previous → the stale verdict + advisory", () => {
    writeProjection();
    const first = readFleetTopology({ cachePath });
    if (first.kind !== "ok") throw new Error("fixture");
    const second = readFleetTopology({ cachePath, previous: first.projection });
    if (second.kind !== "ok") throw new Error("fixture");
    expect(second.verdict).toBe("stale");
    expect(second.advisory).toMatch(/nothing new was published/);
  });

  it("cross-epoch vs the previous → unknown + the force-refetch advisory (never a false-fresh badge)", () => {
    writeProjection();
    const first = readFleetTopology({ cachePath });
    if (first.kind !== "ok") throw new Error("fixture");
    writeProjection({ freshness: { counter: 1, hub_epoch: EPOCH_B } });
    const second = readFleetTopology({ cachePath, previous: first.projection });
    if (second.kind !== "ok") throw new Error("fixture");
    expect(second.verdict).toBe("unknown");
    expect(second.advisory).toMatch(/force refetch/i);
  });
});

// ── the refresh seam: the CLI is the only door ────────────────────────────────

describe("readFleetTopologyWithRefresh — the verb seam (#1106)", () => {
  it("an ok cache NEVER invokes the verb (the fast path — the guard-equivalent read stays cheap)", () => {
    writeProjection();
    let invoked = 0;
    const d = readFleetTopologyWithRefresh({
      cachePath,
      runVerb: () => {
        invoked += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(invoked).toBe(0);
    expect(d.state.kind).toBe("ok");
    expect(d.refreshed).toBe(false);
  });

  it("absent cache → refresh via the verb → re-read ok (the bootstrap path for already-enrolled machines)", () => {
    let invoked = 0;
    const d = readFleetTopologyWithRefresh({
      cachePath,
      runVerb: () => {
        invoked += 1;
        writeProjection();
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    expect(invoked).toBe(1);
    expect(d.refreshed).toBe(true);
    expect(d.state.kind).toBe("ok");
    if (d.state.kind !== "ok") return;
    expect(d.state.role).toBe("client");
  });

  it("broken cache → refresh too (a rejected artifact is repaired through the verb, never read raw)", () => {
    writeProjection({ contract_version: 99 });
    let invoked = 0;
    const d = readFleetTopologyWithRefresh({
      cachePath,
      runVerb: () => {
        invoked += 1;
        writeProjection();
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    expect(invoked).toBe(1);
    expect(d.state.kind).toBe("ok");
  });

  it("verb exit 75 → the bootstrap exception: base-standalone STATED with the pointer, cache untouched, not a mode write", () => {
    writeProjection({ contract_version: 99 }); // broken cache + verb that cannot fix it
    let invoked = 0;
    const d = readFleetTopologyWithRefresh({
      cachePath,
      runVerb: () => {
        invoked += 1;
        return { code: 75, stdout: "base-standalone (bootstrap exception) — grant path: ~/.amico/amicode/entitlements.toml", stderr: "" };
      },
    });
    expect(invoked).toBe(1);
    expect(d.bootstrap).not.toBeNull();
    if (d.bootstrap === null) return;
    expect(d.bootstrap.reason).toBe("verb-75");
    expect(d.bootstrap.stated).toMatch(/base-standalone/);
    expect(d.bootstrap.stated).toMatch(/pointer|grant|checkout|entitlement/i);
    expect(d.state.kind).toBe("broken"); // honest: the cache is still broken
  });

  it("CLI absent → the IDENTICAL bootstrap branch (stated base-standalone + pointer)", () => {
    const absent: VerbRunResult = { code: null, stdout: "", stderr: "ENOENT" };
    const d = readFleetTopologyWithRefresh({ cachePath, runVerb: () => absent });
    expect(d.bootstrap).not.toBeNull();
    if (d.bootstrap === null) return;
    expect(d.bootstrap.reason).toBe("cli-absent");
    expect(d.bootstrap.stated).toMatch(/base-standalone/);
    expect(d.bootstrap.stated).toMatch(/amico fleet status --projection|CLI/i);
  });

  it("a verb FAILURE is NOT bootstrap — a distinct honest state, never mislabeled, never silent", () => {
    writeProjection({ contract_version: 99 });
    const d = readFleetTopologyWithRefresh({
      cachePath,
      runVerb: () => ({ code: 64, stdout: "", stderr: "publisher exploded" }),
    });
    expect(d.bootstrap).toBeNull();
    expect(d.state.kind).toBe("broken");
    if (d.state.kind !== "broken") return;
    expect(d.state.detail).toMatch(/publisher exploded|failed/i);
  });

  it("an unknown-freshness read vs the previous forces the refetch (D1: unknown → refresh + surface)", () => {
    writeProjection();
    const first = readFleetTopology({ cachePath });
    if (first.kind !== "ok") throw new Error("fixture");
    writeProjection({ freshness: { counter: 1, hub_epoch: EPOCH_B } });
    let invoked = 0;
    const d = readFleetTopologyWithRefresh({
      cachePath,
      previous: first.projection,
      runVerb: () => {
        invoked += 1;
        writeProjection({ freshness: { counter: 9, hub_epoch: EPOCH_B } });
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    expect(invoked).toBe(1); // unknown freshness → the forced refetch fired
    expect(d.refreshed).toBe(true);
    expect(d.state.kind).toBe("ok");
  });
});

// ── the cache-path convention ──────────────────────────────────────────────────

describe("the cache-path convention", () => {
  it("the default cachePath is the stable live-layout path (<home>/.amico/ops/fleet/projection.json)", () => {
    mkdirSync(join(tmp, "ops", "fleet"), { recursive: true });
    writeProjection({}, join(tmp, "ops", "fleet", "projection.json"));
    // The default path derives from the process home — assert through the
    // exported hint (the documented convention string) rather than mutating
    // the real HOME: the hint IS the contract the scripts compose from $HOME.
    expect(FLEET_TOPOLOGY_CACHE_DEFAULT_HINT).toBe(".amico/ops/fleet/projection.json");
  });
});

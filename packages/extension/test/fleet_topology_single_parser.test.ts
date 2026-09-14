// fleet_topology_single_parser.test.ts — #1106's grep-style guard test (fleet
// rearchitect P3b-2, spec spec-20260913-114814 row 1 / §8 F1): the extension
// module set contains NO raw fleet.json parsing anymore — the ONE topology
// parser is amicissimo's, behind the `amico fleet` CLI; every amicode-side
// consumer reads the verb-refreshed projection artifact instead. This is the
// single-parser-guard precedent applied as a source scan: it asserts absence
// of the raw-parse idiom at every site the recon identified (the extension's
// typed read in fleet_fallback, the inline parse in terminal, the health
// checks, the activation flows in extension.ts) — a reintroduced raw parser
// fails here even if no behavioral test catches it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (...p: string[]) => join(__dirname, "..", "src", ...p);

function read(...p: string[]): string {
  return readFileSync(src(...p), "utf8");
}

describe("the extension module set parses no raw fleet.json (#1106, F1)", () => {
  it("fleet_fallback is a writer: no JSON.parse, no exported raw-file reader", () => {
    const s = read("fleet_fallback.ts");
    expect(s).not.toMatch(/JSON\.parse/);
    expect(s).not.toMatch(/export function (readFleetConfig|getFleetRole|isFleetClient|getCanonicalPort)/);
  });

  it("terminal carries no fleet.json reference at all — the standalone hint flows through fleet_topology", () => {
    const s = read("terminal.ts");
    expect(s).not.toMatch(/fleet\.json/);
  });

  it("fleet_health consumes the projection topology state, never readFleetConfig", () => {
    const s = read("fleet_health.ts");
    expect(s).not.toMatch(/readFleetConfig/);
    expect(s).not.toMatch(/readFileSync[^;]*fleet\.json/);
    expect(s).toMatch(/fleet_topology/); // the consumer import is present
  });

  it("extension.ts: no raw fleet.json readFileSync; the fleet decisions route through fleet_topology", () => {
    const s = read("extension.ts");
    expect(s).not.toMatch(/readFileSync[^;]*fleet\.json/);
    expect(s).not.toMatch(/from "\.\/fleet_fallback"[^;]*\b(readFleetConfig|getFleetRole|isFleetClient)\b/);
    expect(s).toMatch(/readFleetTopologyWithRefresh/); // the decision path is the projection read
  });

  it("fleet_topology itself holds no raw-file path and no wall clock — reader + verb only", () => {
    const s = read("fleet_topology.ts");
    expect(s).not.toMatch(/fleet\.json/);
    expect(s).not.toMatch(/\bnew Date\b|Date\.now/);
    expect(s).toMatch(/fleetProjectionCachePath|readProjection/);
  });

  it("the reader seam is @amicode/schema — consumed verbatim, never re-defined locally", () => {
    const s = read("fleet_topology.ts");
    expect(s).toMatch(/from "@amicode\/schema"/);
    expect(s).not.toMatch(/function readProjection/); // no shadow of the reader
  });
});

// fleet_fallback.test.ts — #1106 (P3b-2): fleet_fallback is now a WRITER for
// the raw fleet.json (the file amicissimo's ONE parser reads, behind the CLI)
// plus the legacy-marker migration — its raw-file READERS are GONE (the read
// path lives in fleet_topology.ts over the verb-refreshed projection cache;
// the extension never parses fleet.json). These tests pin the writer contract
// exactly, because a malformed write would corrupt the one parser's input:
// the on-disk shape { role, canonical, previous* } must round-trip.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { goStandalone, writeFleetConfig, removeFleetConfig, migrateLegacyFallback, FLEET_CONFIG_PATH, FleetConfig } from "../src/fleet_fallback";

describe("fleet_fallback (the writer — reads go through fleet_topology now)", () => {
  let tmp: string;
  let p: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-config-"));
    p = path.join(tmp, "fleet.json");
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("goStandalone writes role=standalone in the raw file (amicissimo's parser reads this shape)", () => {
    const cfg = goStandalone({ path: p });
    expect(cfg.role).toBe("standalone");
    const onDisk = JSON.parse(readFileSync(p, "utf8")) as FleetConfig;
    expect(onDisk.role).toBe("standalone");
  });

  it("writeFleetConfig writes a parseable client topology the ONE parser can publish", () => {
    writeFleetConfig({ role: "client", canonical: { host: "test-host", port: 4096, sshAlias: "test" } }, p);
    const onDisk = JSON.parse(readFileSync(p, "utf8")) as FleetConfig;
    expect(onDisk.role).toBe("client");
    expect(onDisk.canonical).toMatchObject({ host: "test-host", port: 4096, sshAlias: "test" });
  });

  it("removeFleetConfig deletes the file (no file = the parser's standalone base default)", () => {
    writeFleetConfig({ role: "client" }, p);
    expect(fs.existsSync(p)).toBe(true);
    removeFleetConfig(p);
    expect(fs.existsSync(p)).toBe(false);
  });

  it("goStandalone preserves previous settings for re-enrollment", () => {
    const cfg = goStandalone({ path: p, previousBinary: "/old/bin", previousPort: 4096 });
    expect(cfg.previousBinary).toBe("/old/bin");
    expect(cfg.previousPort).toBe(4096);
  });

  it("migrateLegacyFallback: a legacy fallback.json with no fleet.json → role=standalone written (existence probe + write, never a parse)", () => {
    const legacyDir = path.join(tmp, "ops", "fleet");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, "fallback.json");
    fs.writeFileSync(legacyPath, "anything — the marker is probed, not parsed");
    const configPath = path.join(legacyDir, "fleet.json");
    migrateLegacyFallback({ legacyPath, configPath });
    expect(JSON.parse(readFileSync(configPath, "utf8")).role).toBe("standalone");
    expect(fs.existsSync(legacyPath)).toBe(false); // consumed
  });

  it("migrateLegacyFallback: an existing fleet.json wins — the legacy marker is left alone", () => {
    const legacyDir = path.join(tmp, "ops", "fleet");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, "fallback.json");
    fs.writeFileSync(legacyPath, "marker");
    const configPath = path.join(legacyDir, "fleet.json");
    writeFleetConfig({ role: "client" }, configPath);
    migrateLegacyFallback({ legacyPath, configPath });
    expect(JSON.parse(readFileSync(configPath, "utf8")).role).toBe("client"); // untouched
    expect(fs.existsSync(legacyPath)).toBe(true);
  });
});

describe("fleet_fallback module discipline (#1106: writer, never a parser)", () => {
  it("the module contains NO JSON.parse — a writer never reads topology back", () => {
    const src = readFileSync(path.join(__dirname, "..", "src", "fleet_fallback.ts"), "utf8");
    expect(src).not.toMatch(/JSON\.parse/);
  });

  it("the module exports no raw-file reader — the read path is fleet_topology's alone", () => {
    const src = readFileSync(path.join(__dirname, "..", "src", "fleet_fallback.ts"), "utf8");
    expect(src).not.toMatch(/export function (readFleetConfig|getFleetRole|isFleetClient|getCanonicalPort)/);
  });

  it("FLEET_CONFIG_PATH still points at the live-layout raw file (the writer's destination — unchanged, the parser's input)", () => {
    expect(FLEET_CONFIG_PATH).toBe(path.join(os.homedir(), ".amico", "ops", "fleet", "fleet.json"));
  });
});

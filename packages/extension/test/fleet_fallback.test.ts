import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { goStandalone, enrollFleet, readFleetConfig, getFleetRole, writeFleetConfig, isFleetClient, removeFleetConfig } from "../src/fleet_fallback";

describe("fleet_fallback (fleet config)", () => {
  let tmp: string;
  let p: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-config-"));
    p = path.join(tmp, "fleet.json");
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("goStandalone writes role=standalone", () => {
    const cfg = goStandalone({ path: p });
    expect(cfg.role).toBe("standalone");
    const read = readFleetConfig(p);
    expect(read?.role).toBe("standalone");
  });

  it("getFleetRole returns standalone when no file", () => {
    expect(getFleetRole(p)).toBe("standalone");
  });

  it("getFleetRole reads role from config", () => {
    writeFleetConfig({ role: "client", canonical: { host: "test-host", port: 4096, sshAlias: "test" } }, p);
    expect(getFleetRole(p)).toBe("client");
  });

  it("isFleetClient returns true only for client role", () => {
    expect(isFleetClient(p)).toBe(false);
    writeFleetConfig({ role: "client", canonical: { host: "x", port: 4096 } }, p);
    expect(isFleetClient(p)).toBe(true);
    writeFleetConfig({ role: "server" }, p);
    expect(isFleetClient(p)).toBe(false);
  });

  it("removeFleetConfig deletes the file", () => {
    writeFleetConfig({ role: "client" }, p);
    expect(readFleetConfig(p)).not.toBe(null);
    removeFleetConfig(p);
    expect(readFleetConfig(p)).toBe(null);
  });

  it("goStandalone preserves previous settings", () => {
    const cfg = goStandalone({ path: p, previousBinary: "/old/bin", previousPort: 4096 });
    expect(cfg.previousBinary).toBe("/old/bin");
    expect(cfg.previousPort).toBe(4096);
  });

  it("enrollFleet writes role=client with the canonical topology", () => {
    const cfg = enrollFleet({ sshAlias: "erlich", port: 4096, path: p });
    expect(cfg.role).toBe("client");
    expect(cfg.canonical?.sshAlias).toBe("erlich");
    expect(cfg.canonical?.port).toBe(4096);
    expect(cfg.canonical?.host).toBe("erlich");
    expect(readFleetConfig(p)?.role).toBe("client");
  });

  it("enrollFleet preserves previous settings across the standalone round-trip", () => {
    goStandalone({ path: p, previousBinary: "/old/guard", previousPort: 4096 });
    enrollFleet({ sshAlias: "erlich", path: p });
    const cfg = readFleetConfig(p);
    expect(cfg?.role).toBe("client");
    expect(cfg?.previousBinary).toBe("/old/guard");
    expect(cfg?.previousPort).toBe(4096);
    expect(cfg?.canonical?.port).toBe(4096);
  });

  it("enrollFleet defaults the port from what is on file", () => {
    writeFleetConfig({ role: "standalone", canonical: { host: "x", port: 5050, sshAlias: "x" } }, p);
    const cfg = enrollFleet({ sshAlias: "x", path: p });
    expect(cfg.canonical?.port).toBe(5050);
  });
});

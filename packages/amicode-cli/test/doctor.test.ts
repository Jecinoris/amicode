import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { providerAuthPresent, runtimeReport } from "../src/doctor.js";

const SECRET = "super-secret-key-not-for-stdout";

function cleanEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_DATA_HOME: join(home, "data") };
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY"]) {
    delete env[name];
  }
  return env;
}

describe("runtime doctor lines", () => {
  it("names a missing Julia project without failing the wording into a secret", () => {
    const home = mkdtempSync(join(tmpdir(), "amicode-doctor-"));
    const text = runtimeReport({ home, env: cleanEnv(home), settings: {} });
    expect(text).toContain(`pass  node  ${process.version}`);
    expect(text).toContain("note  provider auth  missing — run amicode auth");
    expect(text).toContain("note  julia  missing — solves will block");
    expect(text).toContain(join(home, ".amico", "julia"));
    expect(text).not.toContain(SECRET);
  });

  it("reports provider auth and a Julia directory without printing the key", () => {
    const home = mkdtempSync(join(tmpdir(), "amicode-doctor-"));
    const auth = join(home, "data", "opencode", "auth.json");
    mkdirSync(join(auth, ".."), { recursive: true });
    writeFileSync(auth, JSON.stringify({ anthropic: { type: "api", key: SECRET } }));
    mkdirSync(join(home, ".amico", "julia"), { recursive: true });
    const env = cleanEnv(home);
    expect(providerAuthPresent(home, env)).toBe(true);
    const text = runtimeReport({ home, env, settings: {} });
    expect(text).toContain("pass  provider auth");
    expect(text).toContain(`pass  julia  ${join(home, ".amico", "julia")}`);
    expect(text).not.toContain(SECRET);
  });
});

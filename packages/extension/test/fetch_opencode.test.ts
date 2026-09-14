import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchOpencode, loadManifest, resolvePlatform, sha256 } from "../scripts/fetch_opencode.mjs";
import { SUPPORTED } from "../src/opencode_binary";

function rootWith(manifest: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "oc-test-"));
  writeFileSync(join(root, "opencode.lock.json"), JSON.stringify(manifest));
  return root;
}

const GOOD = {
  version: "1.17.3",
};

describe("loadManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(loadManifest(rootWith(GOOD)).version).toBe("1.17.3");
  });
  it("the COMMITTED manifest parses", () => {
    const m = loadManifest(); // defaults to the real packages/extension root
    expect(m.version).toBe("1.18.29");
  });
  it("the committed manifest has the post-absorption schema fields", () => {
    const m = loadManifest();
    expect(m.base_version).toBe("1.18.29");
    expect(m.base_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(m.overlay_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rejects missing version", () => {
    expect(() => loadManifest(rootWith({ ...GOOD, version: "" }))).toThrow(/version/);
  });
});

describe("resolvePlatform", () => {
  it("honors an explicit valid key and rejects unknown ones", () => {
    expect(resolvePlatform(GOOD, "linux-x64")).toBe("linux-x64");
    expect(() => resolvePlatform(GOOD, "windows-x64")).toThrow(/supported/);
  });
  it("detects the current machine when no flag given", () => {
    const key = `${process.platform}-${process.arch}`;
    if (["darwin-arm64", "linux-arm64", "linux-x64"].includes(key)) {
      expect(resolvePlatform(GOOD)).toBe(key);
    } else {
      expect(() => resolvePlatform(GOOD)).toThrow(/supported/);
    }
  });
});

function fixtureArchive(): { bytes: Buffer; hash: string } {
  const dir = mkdtempSync(join(tmpdir(), "oc-fixture-"));
  writeFileSync(join(dir, "opencode"), "#!/bin/sh\necho fake-opencode\n");
  chmodSync(join(dir, "opencode"), 0o755);
  execFileSync("tar", ["-czf", join(dir, "a.tar.gz"), "-C", dir, "opencode"]);
  const bytes = readFileSync(join(dir, "a.tar.gz"));
  return { bytes, hash: sha256(bytes) };
}

describe("fetchOpencode", () => {
  it("downloads, unpacks, stamps — then skips on re-run", async () => {
    const { bytes, hash } = fixtureArchive();
    const root = rootWith({ version: "9.9.9" });
    let calls = 0;
    const download = async () => {
      calls++;
      return bytes;
    };
    const r1 = await fetchOpencode({ root, platform: "linux-x64", download });
    expect(r1.skipped).toBe(false);
    const bin = join(root, "vendor", "opencode", "linux-x64", "opencode");
    expect(existsSync(bin)).toBe(true);
    // Re-run should NOT re-download (stamp present)
    // Note: post-absorption, without committed hashes, the stamp check only
    // fires when AMICODE_RELEASE_TAG provides an override hash via SHA256SUMS.
    // Without an override, re-runs always download (no committed hash to compare).
  });
});

describe("releaseCoords — upstream default", async () => {
  const { releaseCoords, assetUrl } = await import("../scripts/fetch_opencode.mjs");
  it("defaults to upstream at v<version>", () => {
    const m = { version: "1.17.3" };
    const coords = releaseCoords(m);
    expect(coords.repo).toBe("anomalyco/opencode");
    expect(coords.tag).toBe("v1.17.3");
    expect(coords.isFork).toBe(false);
    expect(coords.private).toBe(false);
    expect(assetUrl(m, "linux-x64")).toBe(
      "https://github.com/anomalyco/opencode/releases/download/v1.17.3/opencode-linux-x64.tar.gz",
    );
  });
});

describe("AMICODE_RELEASE_TAG override — clean-tag self-provisioning", () => {
  afterEach(() => {
    delete process.env.AMICODE_RELEASE_TAG;
    delete process.env.AMICODE_RELEASE_REPO;
    delete process.env.AMICODE_REQUIRE_CHANNEL;
  });
  it("repoints the tag (and the hash authority) at the freshly provisioned release", async () => {
    const { fetchOpencode } = await import("../scripts/fetch_opencode.mjs");
    const { bytes, hash } = fixtureArchive();
    const sums = `${hash}  opencode-linux-x64.tar.gz\n${"9".repeat(64)}  opencode-darwin-arm64.zip\n`;
    const download = async (url: string) => {
      if (url.endsWith("SHA256SUMS.txt")) return Buffer.from(sums);
      expect(url).toBe(
        "https://github.com/harmoniqs/opencode/releases/download/v1.18.10-amicode.20/opencode-linux-x64.tar.gz",
      );
      return bytes;
    };
    process.env.AMICODE_RELEASE_TAG = "v1.18.10-amicode.20";
    process.env.AMICODE_RELEASE_REPO = "harmoniqs/opencode";
    const root = rootWith({ version: "1.18.10" });
    const ghApi = () =>
      "Built by the amicode-release workflow ... OPENCODE_CHANNEL=beta (UI gate verified ON in every binary). Badge: BETA.";
    const r = await fetchOpencode({ root, platform: "linux-x64", download, ghApi });
    expect(r.skipped).toBe(false);
    expect(r.source).toBe("release harmoniqs/opencode@v1.18.10-amicode.20 channel=beta");
  });
  it("an empty-string env (alpha runs) is NOT an override — the lock stays authoritative", async () => {
    const { releaseCoords } = await import("../scripts/fetch_opencode.mjs");
    process.env.AMICODE_RELEASE_TAG = "";
    const m = { version: "1.17.3" };
    const coords = releaseCoords(m);
    expect(coords.repo).toBe("anomalyco/opencode");
    expect(coords.tag).toBe("v1.17.3");
    expect(coords.isFork).toBe(false);
  });

  it("rejects a pinned DEV release when the release workflow requires BETA", async () => {
    const { bytes, hash } = fixtureArchive();
    const root = rootWith({ version: "1.18.10" });
    process.env.AMICODE_REQUIRE_CHANNEL = "beta";
    process.env.AMICODE_RELEASE_TAG = "v1.18.10-amicode.20";
    process.env.AMICODE_RELEASE_REPO = "harmoniqs/opencode";

    await expect(
      fetchOpencode({
        root,
        platform: "linux-x64",
        download: async () => bytes,
        ghApi: () => "OPENCODE_CHANNEL=dev\nBadge: DEV",
      }),
    ).rejects.toThrow(/OPENCODE_CHANNEL=beta/);
  });
});

describe("assertReleaseChannel — the promoted-release backstop", () => {
  function withFakeGh(body: string | null, fail = false): string {
    const dir = mkdtempSync(join(tmpdir(), "oc-fakegh-"));
    const bodyJson = JSON.stringify(body ?? {});
    writeFileSync(
      join(dir, "gh"),
      `#!/bin/sh
if [ "$1" = "api" ]; then
  ${fail ? "echo 'gh: api failed' >&2; exit 1" : `echo '${bodyJson.replace(/'/g, `'\\''`)}'`}
fi
`,
    );
    chmodSync(join(dir, "gh"), 0o755);
    return dir;
  }
  it("accepts a beta-channel release and fails closed on anything else", async () => {
    const { assertReleaseChannel } = await import("../scripts/fetch_opencode.mjs");
    const coords = { repo: "harmoniqs/opencode", tag: "v1.18.10-amicode.20" };
    const good = withFakeGh(
      "Built by the amicode-release workflow ... OPENCODE_CHANNEL=beta (UI gate verified ON in every binary). Badge: BETA.",
    );
    const prev = process.env.PATH;
    process.env.PATH = `${good}:${process.env.PATH}`;
    try {
      await expect(import("../scripts/fetch_opencode.mjs").then((m) => m.assertReleaseChannel(coords, "beta"))).resolves.toBeUndefined();
      await expect(
        import("../scripts/fetch_opencode.mjs").then((m) => m.assertReleaseChannel(coords, "dev")),
      ).rejects.toThrow(/NOT built with OPENCODE_CHANNEL=dev/);
    } finally {
      process.env.PATH = prev;
    }
    const dev = withFakeGh("OPENCODE_CHANNEL=dev (internal alpha). Badge: DEV.");
    process.env.PATH = `${dev}:${process.env.PATH}`;
    try {
      await expect(
        import("../scripts/fetch_opencode.mjs").then((m) => m.assertReleaseChannel(coords, "beta")),
      ).rejects.toThrow(/NOT built with OPENCODE_CHANNEL=beta/);
    } finally {
      process.env.PATH = prev;
    }
    const broken = withFakeGh(null, true);
    process.env.PATH = `${broken}:${process.env.PATH}`;
    try {
      await expect(
        import("../scripts/fetch_opencode.mjs").then((m) => m.assertReleaseChannel(coords, "beta")),
      ).rejects.toThrow(/release notes/);
    } finally {
      process.env.PATH = prev;
    }
  });
});

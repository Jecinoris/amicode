import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const workflow = (name: string) => readFileSync(path.join(root, ".github", "workflows", name), "utf8");
const workflowExists = (name: string) => existsSync(path.join(root, ".github", "workflows", name));

describe("release workflow payload integrity", () => {
  it("builds from overlay (no fork download) and promotes from the tagged payload", () => {
    const release = workflow("release.yml");
    const promote = workflow("promote.yml");
    const ci = workflow("ci.yml");

    // Fork-centric workflows are retired (#1096)
    expect(workflowExists("prepare-release-candidate.yml")).toBe(false);
    expect(workflowExists("overlay-promotion-bot.yml")).toBe(false);

    // release.yml builds from overlay, not fork
    expect(release).toContain("build_binary.mjs");
    expect(release).not.toContain("OPENCODE_FETCH_TOKEN");
    expect(release).not.toContain("REPO_ACCESS_TOKEN");
    expect(release).not.toContain("fetch_opencode.mjs");
    expect(release).toContain("Publish to VS Code Marketplace");
    expect(release).toContain("build-binary");

    // ci.yml has a build-binary job, no fetch:opencode calls
    expect(ci).toContain("build-binary:");
    expect(ci).not.toContain("fetch:opencode");
    expect(ci).not.toContain("OPENCODE_FETCH_TOKEN");
    expect(ci).toContain("download-artifact");

    // promote.yml dispatches release.yml correctly
    expect(promote).toContain('gh workflow run release.yml --ref "$CLEAN" -f tag="$CLEAN"');
  });
});

#!/usr/bin/env node
// Committed-overlay integrity check — verifies the overlay tree matches the
// manifest. Post-absorption: no fork comparison (the fork is absorbed).
//
//   node scripts/drift_gate.mjs
//
// Exit 0 = in sync. Exit 1 = drift (names the first divergence).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PKG_ROOT = join(import.meta.dirname, "..");

const manifestPath = join(PKG_ROOT, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const fail = (msg) => {
  console.error(`[drift-gate] FAIL: ${msg}`);
  process.exit(1);
};

// ── 1. upstream base archive verifies against the manifest's recorded sha ───
const cacheStamp = join(PKG_ROOT, ".cache", `anomalyco_opencode@${manifest.upstream_base}`, "sha256");
if (existsSync(cacheStamp)) {
  if (manifest.upstream_base_archive_sha256 === undefined) {
    fail(`manifest has no upstream_base_archive_sha256 for ${manifest.upstream_base}`);
  }
  const got = readFileSync(cacheStamp, "utf8").trim();
  if (got !== manifest.upstream_base_archive_sha256) {
    fail(`cached archive sha ${got.slice(0, 10)} != manifest.upstream_base_archive_sha256 ${manifest.upstream_base_archive_sha256.slice(0, 10)}`);
  }
  console.log(`[drift-gate] upstream base archive verified: ${manifest.upstream_base} @ ${got.slice(0, 10)}`);
} else {
  console.log(`[drift-gate] SKIP: no cached archive for ${manifest.upstream_base} — materialize to verify the archive sha`);
}

// ── 2. committed overlay/ matches the manifest (always runs) ────────────────
const overlayDir = join(PKG_ROOT, "overlay");
const onDisk = new Set();
for (const rel of readdirSync(overlayDir, { recursive: true })) {
  const p = join(overlayDir, rel.toString());
  const st = lstatSync(p);
  if (st.isSymbolicLink()) {
    onDisk.add(rel.toString());
    continue;
  }
  if (st.isFile()) onDisk.add(rel.toString());
}
const exceptionFiles = manifest.exceptions ?? [];
if (!Array.isArray(exceptionFiles)) fail("manifest exceptions must be an array");
const declaredFiles = { ...manifest.files };
for (const exception of exceptionFiles) {
  if (!exception || typeof exception.path !== "string" || typeof exception.sha256 !== "string" ||
    typeof exception.reason !== "string" || typeof exception.review !== "string") {
    fail("each manifest exception needs path, sha256, reason, and review");
  }
  if (declaredFiles[exception.path] !== undefined) fail(`exception duplicates a fork-owned overlay file: ${exception.path}`);
  declaredFiles[exception.path] = exception.sha256;
}
const inManifest = new Set(Object.keys(declaredFiles));
const stray = [...onDisk].filter((f) => !inManifest.has(f));
const missing = [...inManifest].filter((f) => !onDisk.has(f));
if (stray.length > 0) fail(`stray files in overlay/ not in the manifest: ${stray.slice(0, 3).join(", ")}${stray.length > 3 ? " …" : ""}`);
if (missing.length > 0) fail(`manifest files missing from overlay/: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " …" : ""}`);
for (const [rel, want] of Object.entries(declaredFiles)) {
  const p = join(overlayDir, rel);
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) fail(`overlay file missing on disk: ${rel}`);
  const h = st.isSymbolicLink()
    ? createHash("sha256").update(readlinkSync(p)).digest("hex")
    : createHash("sha256").update(readFileSync(p)).digest("hex");
  if (h !== want) fail(`overlay file hash mismatch (hand-edit?): ${rel} — re-run the extractor`);
}
console.log(`[drift-gate] committed overlay verified against the manifest (${onDisk.size} files)`);
console.log("[drift-gate] PASS: overlay and manifest are in sync");

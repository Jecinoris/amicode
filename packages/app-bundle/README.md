# @amicode/app-bundle — the engine source overlay

The Amicode engine source tree. This overlay is applied on top of a pinned
**canonical opencode** base to produce the Amicode-branded binary. The overlay
IS the source of truth — edit it directly.

## How it works

The overlay contains all Amicode-specific patches to the opencode engine.
At build time, the materializer fetches the canonical upstream tarball,
applies the overlay (adds/overwrites + manifest deletions), and the result
is compiled into the vendored binary.

```sh
# compile the engine binary from the overlay
pnpm --filter amicode run build:binary

# materialize a full source tree: canonical base + overlay (for inspection)
node scripts/materialize.mjs --out <dir> [--tag v1.18.12] [--repo anomalyco/opencode]
```

bun is required for compilation. The binary lands in
`packages/extension/vendor/opencode/<platform>/opencode`.

## History

This overlay was extracted from the `harmoniqs/opencode` fork (the M2
fork-absorption milestone, #1091). The fork is now archived; all engine
development happens directly in this overlay.

### Extraction provenance

**Slice (b) — the complete app-graph delta:**
Scope: the complete fork-vs-base delta of the app's build graph —
`packages/{app,ui,session-ui,schema,core,sdk}` — 422 files. Machine-derived
from the fork at `v1.18.10-amicode.14` against upstream `v1.18.12`.

**Slice (a) — the complete `packages/ui` delta:**
Scope: every file under `packages/ui` the fork changed vs the upstream base —
164 files (142 added, 22 modified). `materialize(upstream v1.18.12, overlay)`
produces a `packages/ui` byte-identical to the fork's at the pin.

### Proofs (all green at extraction, 2026-08-21)

1. **Equivalence** — every overlay file byte-identical to the fork's at the
   pin (round-trip verified at extraction; manifest hash-verified at
   materialization).
2. **Composition** — `bun install` → typecheck chain → `app` vite production
   build (14.3s, 1,587 assets) → **103/103 session-ui unit tests**.

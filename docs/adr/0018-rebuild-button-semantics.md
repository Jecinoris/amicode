# The developer Rebuild has two modes — local builds the working tree, main syncs first — and the binary live-swap is retired

Status: accepted (2026-09-13)

The developer-tools Rebuild surface offers two buttons, and after the opencode fork was
absorbed (#1091) the amicode binary is built from the overlay/materialized tree in-repo —
there is no longer a separate opencode repository to point at or a fork binary to swap in.
This ADR records what the two buttons now mean and why the field that fed the old binary
live-swap is gone.

**The two modes.** The Rebuild request carries a `mode` with exactly two values.
`local` builds the current working tree **as it sits** — no git checkout, no pull — so a
developer's in-progress edits are what gets built. `main` syncs the amicode repo to
`origin/main` first (`git fetch origin && git checkout main && git pull --ff-only origin
main`) and then builds. The two are intentionally non-interchangeable: `local` is the
inner-loop "build what I have" action, `main` is the "reset to the shared tip and build
that" action. The vocabulary is `local | main` end to end — UI button, controller
payload, extension-host handler, and tests — replacing the fork-era `remote` value, which
is retired and resolves to the safe, non-destructive `local` default if it is ever seen.

**Why they must differ observably.** Before this decision the handler ignored `mode` and
always ran the checkout-main + fast-forward pull, so "Rebuild Locally" silently discarded
the working tree by pulling to main — the two buttons were identical and the local button
was actively misleading. The git step is now the single point where the two modes diverge,
derived from `mode` by one pure function so the difference is directly testable: `local`
emits no git command, `main` emits the fetch/checkout/ff-pull.

**The binary live-swap is retired.** The old surface carried an "opencode repo path" field
whose only job was to resolve a fork binary from a path on disk and set the
`amicode.opencodeBinary` override to it (a live-swap), restarting the server. In the
overlay-build world that path points at nothing meaningful: the binary is produced by the
in-repo build, not resolved from a sibling fork checkout. The field, its controller
getter/setter/commit, its settings-context entry, its localization keys, and the two
path-fed binary writes in the update handler are all removed. The full local Rebuild is now
the single dev build path.

**What is preserved.** The general `amicode.opencodeBinary` override setting is *not* the
live-swap and is kept intact: it is consumed by the fleet-health and boot-override paths,
and the developer-mode toggle-off must still clear it (alongside `devAssetRoot`) when
restoring the marketplace build. Only the binary write that the removed path field fed is
gone; the override's boot/health consumers and its toggle-off clear are untouched.

**Alternatives considered.** Keeping a single Rebuild button was rejected — developers
genuinely need both "build my tree" and "build the shared tip", and collapsing them is what
produced the silent data-losing pull. Repurposing the opencode-path field to point at the
amicode repo was rejected as redundant with the existing amicode-path field. Retiring the
buttons in favor of a CLI-only rebuild was rejected as a workflow regression for the
in-editor developer loop.

**Consequence.** Retiring the fork shell scripts (S9) and the orphaned coordinator
main-path (S10) are follow-ups outside this slice; this decision is the request surface and
the removal, not a change to the overlay build engine itself.

Implementation: harmoniqs/amicode#1115

# Fleet-client e2e harness (#1290)

Headless regression net for the fleet client's never-blank contract. Born
from the 2026-09-19/20 debugging night: every gate, hold, and boundary in
the app was found by shipping builds and reading a debug badge by hand.
This harness encodes the same observations as assertions so future work
ships without a human in the loop.

## Status: GREEN (2026-09-20)

`run_all.sh` exits 0: both passes (0ms and 800ms simulated intercontinental
latency) report `boot_blank=0ms flow_blank=0ms errors=0`.

It exercises the real dist end-to-end: boot → draft landing → sessions
view → open Alpha/Beta → tab switches back and forth, asserting:

1. The router outlet never goes empty (main:0) beyond 400ms.
2. The session panel frame ([data-amicode-panel]) never vanishes on
   /session/ routes (draft views and the sessions list legitimately have
   none — the observer scopes the check to where a frame is owed).
3. No console errors / uncaught exceptions beyond the benign
   ResizeObserver loop notice.

## Layout

- `mock_hub.py` — a mock amicode hub: serves the REAL app dist plus the
  API surface the app actually calls. Dual-protocol (v1 bare shapes +
  v2 `/api/*` wrapped shapes), all captured from the live hub.
  `--latency N` delays every response to simulate the wire.
- `fixtures/` — responses captured verbatim from the live hub
  (provider, model, agent, command). Serve real payloads, not guesses:
  the normalizers parse real entries and hand-rolled ones used to trip
  the bootstrap ("Failed to finish bootstrap instance").
- `drive_test.py` — the CDP driver: boots the app headless, drives the
  flows, runs the never-blank observer (the night's debug badge,
  promoted to assertions), captures console.error + exceptions.
- `run_all.sh` — the canonical entry: mock + headless chrome + both
  latencies. Exit 0 = safe to ship.

## Hard-won protocol facts (do not regress these)

- The real fleet client speaks **v1**: `detectServerProtocol` probes
  `/global/health` FIRST and `{healthy: true}` wins. The mock must return
  exactly `{"healthy": true, "version": "..."}` or headless clients pick
  v2 and diverge from production behavior.
- The SSE stream is close-delimited (`Connection: close`) — the app's
  fetch-stream reader rejects a raw HTTP/1.1 keep-alive body with no
  framing and reports "event stream failed".
- Per-directory polls the v1 bootstrap instance awaits: /question,
  /permission, /mcp, /lsp, /experimental/resource, /vcs, /project/current,
  /agent, /command, /amicode/warrants. A 404 on any of them surfaces as
  "Failed to finish bootstrap instance" console noise (and fails this
  harness's error gate).
- The tab strip renders tabs as `<a>` anchors; titlebar buttons are
  aria-labeled, not text-labeled.

## Running

    ops/e2e-fleet/run_all.sh [app-dist-dir]

(default dist: the materialized app build). Requires python3 with
websocket-client and headless Chrome.

## Roadmap (the seamless trio, each landing behind this net)

1. Durable mirror (IndexedDB hydration) — reload boots into the last
   session fully rendered. Test: reload mid-flow, assert zero blank and
   instant content.
2. Lossless SSE reconnect (#1264) — frontdoor ring buffer + Last-Event-ID
   replay. Test: kill the SSE mid-stream in the mock, assert the gap
   heals without any re-sync churn.
3. Optimistic send rendering — the sent message renders immediately with
   a pending style. Test: send, assert the text is visible within a
   frame even at 800ms latency.

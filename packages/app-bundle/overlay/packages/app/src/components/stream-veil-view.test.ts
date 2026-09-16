import { describe, expect, test } from "bun:test"
import { streamVeilView } from "./stream-veil-view"

// amicode#1203 AC1/AC2 — the session view's render response to stream loss, at
// the state level the veil projects from (the DOM contract itself is pinned by
// session-stream-veil.test.ts — bun cannot run Solid's dom-expressions
// transform, so the projection is source-asserted, per the
// lineage-ledger-panel.test.tsx precedent).

describe("streamVeilView (#1203)", () => {
  test("a live stream shows nothing — the session view is untouched", () => {
    const view = streamVeilView({ degraded: false, label: "Reconnecting" })
    expect(view.show).toBe(false)
  })

  test("stream loss degrades in place: the veil state is stale, never a teardown signal", () => {
    const view = streamVeilView({ degraded: true, label: "Reconnecting" })
    expect(view.show).toBe(true)
    expect(view.state).toBe("stale")
  })

  test("the loss and the recovery are announced, politely", () => {
    const view = streamVeilView({ degraded: true, label: "Reconnecting" })
    expect(view.role).toBe("status")
    expect(view.live).toBe("polite")
  })

  test("the badge carries the reconnecting label verbatim", () => {
    const label = "Connection lost — showing your last synced messages"
    expect(streamVeilView({ degraded: true, label }).label).toBe(label)
  })
})

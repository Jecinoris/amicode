export type StreamVeilView = {
  /** only the gap (a loss AFTER a first successful connect) degrades the view */
  show: boolean
  /** the degraded state the DOM projection stamps on the veil */
  state: "stale"
  /** live-region role + politeness: the loss and the recovery are announced */
  role: "status"
  live: "polite"
  label: string
}

/**
 * amicode#1203 — the pure render-state behind the session view's reconnecting
 * veil. Bun's test transpiler does not run Solid's dom-expressions transform
 * (see lineage-ledger-panel.test.tsx), so the veil's behavioral substance lives
 * here, directly tested, and session-stream-veil.tsx is a thin DOM projection
 * of this view.
 *
 * The #638 honest-liveness machine (server-sdk's event status) owns detection;
 * this owns only the render response: over the LAST RENDERED session view —
 * which stays mounted the whole time — the projection draws a dim layer plus a
 * small reconnecting badge. On reconnect `show` flips false and the same
 * mounted view continues; nothing reloads, nothing refetches the session list.
 */
export function streamVeilView(input: { degraded: boolean; label: string }): StreamVeilView {
  return {
    show: input.degraded,
    state: "stale",
    role: "status",
    live: "polite",
    label: input.label,
  }
}

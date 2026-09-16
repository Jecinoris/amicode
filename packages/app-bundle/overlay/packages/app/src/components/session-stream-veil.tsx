import { Show } from "solid-js"
import type { Accessor } from "solid-js"
import { streamVeilView } from "./stream-veil-view"

/**
 * amicode#1203 — the reconnecting veil over the session view.
 *
 * When the SSE stream drops, the session view must SURVIVE: the last rendered
 * timeline + composer stay mounted, dimmed under this veil, with a small
 * reconnecting badge — the degraded-state vocabulary the v2 tokens give other
 * degraded surfaces (as in the connection banner). The veil never blocks
 * interaction (`pointer-events: none`): the composer refuses sends honestly
 * during the gap instead of being disabled blindly. The badge is static (no
 * animation), so reduced-motion users get the identical treatment; the pure
 * view's `role="status"` + `aria-live="polite"` announce the loss and the
 * recovery.
 *
 * bun's test transpiler does not run Solid's dom-expressions transform, so the
 * behavioral substance lives in the pure view (stream-veil-view.ts) and this
 * component is a thin projection of it (see lineage-ledger-panel.test.tsx).
 */
export function SessionStreamVeil(props: {
  degraded: Accessor<boolean>
  label: string
}) {
  const view = () => streamVeilView({ degraded: props.degraded(), label: props.label })
  return (
    <Show when={props.degraded()}>
      <div
        data-component="session-stream-veil"
        data-state={view().state}
        role={view().role}
        aria-live={view().live}
        style={{
          position: "absolute",
          inset: "0",
          "z-index": "30",
          "pointer-events": "none",
        }}
      >
        <div
          data-slot="session-stream-veil-dim"
          style={{
            position: "absolute",
            inset: "0",
            background: "var(--v2-background-bg-deep, #141414)",
            opacity: "0.55",
          }}
        />
        <div
          data-slot="session-stream-veil-badge"
          style={{
            position: "absolute",
            top: "12px",
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            "align-items": "center",
            gap: "6px",
            padding: "4px 12px",
            "border-radius": "var(--radius-full, 9999px)",
            border: "1px solid var(--v2-border-border-base, #3c3c3c)",
            background: "var(--v2-background-bg-layer-01, #1e1e1e)",
            "box-shadow": "0 8px 24px rgba(0, 0, 0, 0.35)",
            color: "var(--v2-state-fg-warning, #d29922)",
            "font-size": "12px",
            "font-weight": "600",
            "white-space": "nowrap",
          }}
        >
          {view().label}
        </div>
      </div>
    </Show>
  )
}

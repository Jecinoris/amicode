import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// amicode#1203 — the veil's DOM projection contract. bun's test transpiler does
// not run Solid's dom-expressions transform (see lineage-ledger-panel.test.tsx
// for the repo-wide precedent), so the projection is a SOURCE assertion and the
// behavioral substance lives in stream-veil-view.test.ts.

const source = readFileSync(join(import.meta.dir, "session-stream-veil.tsx"), "utf8")
// comments describe the contract — the assertions below pin the CODE
const code = source.replace(/\/\*[\s\S]*?\*\//g, "")

describe("SessionStreamVeil — projection contract (#1203)", () => {
  test("presence-only Show: the veil appears over the view, it never remounts content beneath", () => {
    // A Show (not keyed, not a Switch replacement) mounts/unmounts ONLY the
    // veil — the last rendered session view beneath it stays mounted through
    // the whole loss/reconnect cycle.
    expect(source).toContain("<Show when={props.degraded()}>")
  })

  test("the veil dims and badges — it never blocks interaction", () => {
    // The composer's honest send refusal (submit-stream-gap.test.ts) owns
    // input degradation; the veil only dims.
    expect(source).toContain('"pointer-events": "none"')
    expect(source).toContain("position: \"absolute\"")
    expect(source).toContain("inset: \"0\"")
  })

  test("the a11y contract comes from the pure view (status / polite / stale)", () => {
    expect(code).toContain("from \"./stream-veil-view\"")
    expect(code).toContain("role={view().role}")
    expect(code).toContain("aria-live={view().live}")
    expect(code).toContain("data-state={view().state}")
    expect(code).toContain('data-component="session-stream-veil"')
  })

  test("the badge is static — reduced-motion users get the identical treatment", () => {
    // No animation/transition declarations anywhere in the projection: the
    // badge is still, the dim is a fixed opacity. There is nothing for
    // prefers-reduced-motion to opt out of.
    expect(code).not.toMatch(/animation|transition|animate|@keyframes/)
  })

  test("degraded styling rides the v2 theme tokens, with safe fallbacks", () => {
    expect(code).toContain("var(--v2-background-bg-deep")
    expect(code).toContain("var(--v2-state-fg-warning")
    expect(code).toContain("var(--v2-border-border-base")
  })

  test("caller passes the streamGap ACCESSOR, not its value (#1203 regression)", () => {
    // props.degraded is Accessor<boolean> — the veil calls props.degraded()
    // internally. Passing degraded={streamGap()} (the value) makes that call
    // throw `t.degraded is not a function` and blanks the whole session view.
    // Must be degraded={streamGap}.
    const callSite = readFileSync(join(import.meta.dir, "..", "pages", "session.tsx"), "utf8")
    const m = callSite.match(/<SessionStreamVeil\s+degraded=\{([^}]*)\}/)
    expect(m).not.toBeNull()
    expect(m![1].trim()).toBe("streamGap")
  })
})

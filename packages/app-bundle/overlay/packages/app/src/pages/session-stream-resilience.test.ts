import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// amicode#1203 AC1/AC4 — the session page's render response to the #638 machine:
// the veil rides OVER the session panel (outside its error boundary, so a torn
// render cannot take the indicator down with it), and the stale-resource read
// stops suspending/throwing away a timeline that is already rendered from cache.
//
// SOURCE assertions — session.tsx mounts a dozen providers; the package has no
// component-render harness for the full page (see
// prompt-input-clipboard-structure.test.ts for the precedent).

const session = readFileSync(join(import.meta.dir, "session.tsx"), "utf8")

describe("session page render response (#1203)", () => {
  test("the stale-resource read no longer tears down a timeline that is ready from cache", () => {
    // {sessionSync() ?? ""} suspends on refetch and THROWS when a refetch fails
    // (tunnel blip + tab switch = the reported blank session). Gating it on
    // !messagesReady() keeps the cached timeline mounted; a session with no
    // cache still suspends/throws exactly as before.
    expect(session).toContain("<Show when={!messagesReady()}>")
  })

  test("the reconnecting veil renders over the session panel", () => {
    expect(session).toContain("SessionStreamVeil")
    expect(session).toContain("session.stream.reconnecting")
  })

  test("en carries the honest badge + refusal copy", async () => {
    const module: unknown = await import("@/i18n/en")
    const dict = (module as { dict: Record<string, string> }).dict
    expect(dict["session.stream.reconnecting"]).toBeTruthy()
    expect(dict["prompt.toast.connectionDropped.title"]).toBeTruthy()
    expect(dict["prompt.toast.connectionDropped.description"]).toBeTruthy()
  })
})

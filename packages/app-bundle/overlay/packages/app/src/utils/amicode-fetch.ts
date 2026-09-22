// amicode: shared GET against the active server's /amicode/* raw routes
// (spec B). Same per-active-server Basic-auth idiom as the Vaults tab fetch
// (status-popover-body.tsx). Resolves the connection PER CALL, so a server
// switch is picked up by the very next fetch — no dedicated refetch trigger.
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

export async function amicodeGet(conn: ServerConnection.Any | undefined, route: string): Promise<unknown> {
  if (!conn) throw new Error("no active server")
  const headers: Record<string, string> = {}
  if (conn.http.password)
    headers.Authorization = `Basic ${authTokenFromCredentials({
      username: conn.http.username,
      password: conn.http.password,
    })}`
  const res = await fetch(new URL(route, conn.http.url), { headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // #1313: unknown paths can reach a SPA fallback (the engine serves HTML
  // with 200 for routes it doesn't know) — parsing that threw "Unexpected
  // token '<'" through error boundaries. A non-JSON content-type is a
  // wrong-origin/wrong-route answer: a clean error callers can catch.
  const ct = res.headers.get("content-type") || ""
  if (!ct.includes("json")) throw new Error(`non-JSON response for ${route} (${ct || "no content-type"})`)
  return (await res.json()) as unknown
}

/** POST sibling of amicodeGet — the amicode raw routes keep params in the URL
 *  (no body), so this is the same call shape with method POST. Used by the
 *  About-You card's in-place profile save. */
export async function amicodePost(
  conn: ServerConnection.Any | undefined,
  route: string,
  jsonBody?: unknown,
): Promise<unknown> {
  if (!conn) throw new Error("no active server")
  const headers: Record<string, string> = {}
  if (conn.http.password)
    headers.Authorization = `Basic ${authTokenFromCredentials({
      username: conn.http.username,
      password: conn.http.password,
    })}`
  if (jsonBody !== undefined) headers["content-type"] = "application/json"
  const res = await fetch(new URL(route, conn.http.url), {
    method: "POST",
    headers,
    ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const ct2 = res.headers.get("content-type") || ""
  if (!ct2.includes("json")) throw new Error(`non-JSON response for ${route} (${ct2 || "no content-type"})`)
  return (await res.json()) as unknown
}

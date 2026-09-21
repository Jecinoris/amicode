import { createSimpleContext } from "@opencode-ai/ui/context"
import { queryOptions, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, onCleanup } from "solid-js"
import type { WslServersState } from "./types"
import { usePlatform } from "../context/platform"

const wslServersQueryKey = ["platform", "wslServers"] as const

export const { use: useWslServers, provider: WslServersProvider } = createSimpleContext({
  name: "WslServers",
  init: () => {
    const platform = usePlatform()
    const api = platform.wslServers

    // #1308: WSL is Windows-only. When the platform API is absent (macOS,
    // the fleet hub client), a query here is disabled-forever — and
    // solid-query's internally-tracked resource read re-registers that
    // pending resource into EVERY route transition, freezing every session
    // switch behind a subsystem the platform doesn't even have (forever in
    // the rig, ~the platform handshake's latency on the real hub — the
    // entire "8.2 second switch" arc's last hiding place). No API, no
    // query, no resource, no suspension: a static empty state. The
    // settings UI treats data === undefined as "no servers" either way.
    if (!api) {
      const empty = Object.assign(() => undefined, {
        ready: true,
        data: undefined,
        status: "pending" as const,
        isPending: true,
        error: null,
      })
      return empty as never
    }

    const queryClient = useQueryClient()
    const query = useQuery(() => {
      return queryOptions<WslServersState>({
        queryKey: wslServersQueryKey,
        queryFn: () => api!.getState(),
        enabled: !!api,
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: Number.POSITIVE_INFINITY,
      })
    })

    createEffect(() => {
      const off = api.subscribe((event) => {
        queryClient.setQueryData(wslServersQueryKey, event.state)
      })
      onCleanup(off)
    })

    return Object.assign(query, { ready: true }) as typeof query & {
      readonly data: WslServersState | undefined
    }
  },
})

import type { ConnectionInfo } from "@opencode/client"
import { z } from "zod"

export interface OpenAIConnections {
  active(): Promise<ConnectionInfo | undefined>
  list(): Promise<ConnectionInfo[]>
  resolve(connection: ConnectionInfo): Promise<unknown>
}

export function codexHost(connections: OpenAIConnections, selectedID?: string) {
  return {
    async active() {
      const connection = selectedID
        ? (await connections.list()).find((item) => item.type === "credential" && item.id === selectedID)
        : await connections.active()
      if (!connection) return undefined
      return {
        key: connection.type === "credential" ? connection.id : `env:${connection.name}`,
        label: connection.type === "credential" ? connection.label : "Environment connection",
        resolve: () => connections.resolve(connection),
      }
    },
  }
}

const AuthMethod = z.object({ type: z.string(), methodID: z.string().optional() })
export const QuotaConnection = z.object({
  id: z.string(),
  label: z.string(),
  method: z.string(),
  codexNative: z.boolean(),
  available: z.boolean(),
})

/** Diagnostic metadata only. Tokens never leave the host resolver's process. No activation. */
export async function listQuotaConnections(connections: OpenAIConnections) {
  const result: z.infer<typeof QuotaConnection>[] = []
  for (const connection of await connections.list()) {
    if (connection.type !== "credential" || connection.method !== "oauth") continue
    const auth = AuthMethod.safeParse(await connections.resolve(connection).catch(() => undefined))
    const method = auth.success ? (auth.data.methodID ?? auth.data.type) : "unavailable"
    result.push({
      id: connection.id,
      label: connection.label,
      method,
      codexNative: method === "chatgpt-browser" || method === "chatgpt-headless",
      available: auth.success,
    })
  }
  return result
}

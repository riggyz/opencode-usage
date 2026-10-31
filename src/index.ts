import { Plugin } from "@opencode/plugin"
import { isAbsolute } from "node:path"
import { z } from "zod"
import { CodexCollector } from "./collector"
import { readClaudeFeed } from "./providers/claude"
import { claudeObserver } from "./providers/claude-observer"
import { Usage } from "./rpc"
import type { ProviderSnapshot } from "./model"
import { codexHost, listQuotaConnections } from "./connections"
import { SnapshotCache } from "./snapshot-cache"

const Options = z.object({
  codex: z.boolean().default(true),
  codexConnectionID: z.string().optional(),
  claude: z.boolean().default(true),
  claudeStatuslineFile: z.string().refine(isAbsolute, "Claude feed path must be absolute").optional(),
})

export default Plugin.define({
  id: "riggyz.usage",
  async setup(ctx) {
    const options = Options.parse(ctx.options)
    const storedSelection = await ctx.storage.get("codex-quota-connection")
    let selectedID = options.codexConnectionID ?? (typeof storedSelection === "string" ? storedSelection : undefined)
    const cache = new SnapshotCache(ctx.storage)
    const connections = {
      active: () => ctx.integration.connection.active("openai"),
      list: async () => (await ctx.integration.get({ integrationID: "openai" })).data.connections,
      resolve: (connection: Parameters<typeof ctx.integration.connection.resolve>[0]) =>
        ctx.integration.connection.resolve(connection),
    }
    const quotaHost = {
      active: async () => {
        const saved = await ctx.storage.get("codex-quota-connection")
        selectedID = options.codexConnectionID ?? (typeof saved === "string" ? saved : undefined)
        return codexHost(connections, selectedID).active()
      },
    }
    const collector = new CodexCollector(quotaHost)
    const activeClaude = async () => {
      const connection = await ctx.integration.connection.active("anthropic")
      if (!connection) return undefined
      return {
        key: connection.type === "credential" ? connection.id : `env:${connection.name}`,
        label: connection.type === "credential" ? connection.label : "Environment connection",
      }
    }
    const requests = new WeakMap<Request, Awaited<ReturnType<typeof activeClaude>>>()
    const requestHook = options.claude
      ? await ctx.session.hook(
          "http.request",
          async (event) => {
            if (event.model.providerID !== "anthropic") return
            claudeObserver.diagnostics.requests++
            const account = await activeClaude().catch(() => undefined)
            if (account) requests.set(event.request, account)
          },
          { providerID: "anthropic" },
        )
      : undefined
    const responseHook = options.claude
      ? await ctx.session.hook(
          "http.response",
          async (event) => {
            if (event.model.providerID !== "anthropic") return
            claudeObserver.diagnostics.responses++
            const account = requests.get(event.request)
            requests.delete(event.request)
            if (account) {
              claudeObserver.diagnostics.bound++
              claudeObserver.observe(account.key, account.label, event.response.headers)
              await cache.write(account.key, claudeObserver.read(account.key, account.label)).catch(() => undefined)
            }
          },
          { providerID: "anthropic" },
        )
      : undefined
    const registration = await ctx.rpc.register(Usage, {
      codexConnections: () => listQuotaConnections(connections),
      selectCodexConnection: async (input) => {
        const available = await listQuotaConnections(connections)
        if (
          !available.some((connection) => connection.id === input.id && connection.codexNative && connection.available)
        )
          return { selected: false }
        if (options.codexConnectionID && options.codexConnectionID !== input.id) return { selected: false }
        await ctx.storage.set("codex-quota-connection", input.id)
        selectedID = input.id
        return { selected: true }
      },
      claudeDiagnostics: async () => ({ ...claudeObserver.diagnostics }),
      async snapshot(input) {
        const providers: ProviderSnapshot[] = []
        if (options.codex) {
          const connection = await quotaHost.active().catch(() => undefined)
          const saved = connection ? await cache.read("codex", connection.key) : undefined
          const codex =
            !input.refresh && saved && Date.now() - saved.fetchedAt! < 120_000
              ? { ...saved, accountLabel: connection!.label }
              : await collector.read(input.refresh)
          if (connection) await cache.write(connection.key, codex).catch(() => undefined)
          providers.push(
            selectedID
              ? { ...codex, message: `Separate saved quota connection (not inference selection). ${codex.message}` }
              : codex,
          )
        }
        if (options.claude) {
          const account = await activeClaude().catch(() => undefined)
          const local = claudeObserver.read(account?.key, account?.label)
          const saved = account ? await cache.read("claude", account.key) : undefined
          const observed =
            saved && (saved.fetchedAt ?? 0) > (local.fetchedAt ?? 0)
              ? { ...saved, accountLabel: account!.label }
              : local
          const feed = options.claudeStatuslineFile ? await readClaudeFeed(options.claudeStatuslineFile) : undefined
          providers.push(observed.windows.length ? observed : (feed ?? observed))
        }
        return { providers }
      },
    })
    return async () => {
      collector.dispose()
      await requestHook?.dispose()
      await responseHook?.dispose()
      await registration.dispose()
    }
  },
})

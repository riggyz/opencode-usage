import type { ProviderSnapshot } from "./model"
import { fetchCodexUsage, UsageFailure, type CodexHost } from "./providers/codex"

const base: ProviderSnapshot = {
  provider: "codex",
  source: "codex-oauth-private",
  accountLabel: "OpenCode OpenAI connection",
  status: "signed-out",
  message: "No active OpenAI connection.",
  fetchedAt: null,
  retryAt: null,
  windows: [],
}

/** Demand-driven, account-scoped cache. No interval, persistence, raw errors, or refresh tokens. */
export class CodexCollector {
  private key: string | undefined
  private cached: ProviderSnapshot = { ...base }
  private pending: Promise<ProviderSnapshot> | undefined
  private nextAt = 0
  private failures = 0
  private controller = new AbortController()
  private stopped = false

  constructor(
    private host: CodexHost,
    private request: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  dispose() {
    this.stopped = true
    this.controller.abort()
  }

  async read(refresh = false): Promise<ProviderSnapshot> {
    if (this.stopped) return { ...base, status: "unavailable", message: "Plugin stopped." }
    const connection = await this.host.active().catch(() => undefined)
    if (this.stopped) return { ...base, status: "unavailable", message: "Plugin stopped." }
    if (connection?.key !== this.key) {
      this.controller.abort()
      this.controller = new AbortController()
      this.key = connection?.key
      this.cached = { ...base, accountLabel: connection?.label ?? base.accountLabel }
      this.nextAt = 0
      this.failures = 0
      this.pending = undefined
    }
    if (!connection) return { ...base }
    if (this.pending) return this.pending
    const now = this.now()
    // Manual refresh bypasses normal TTL but never backoff/auth cooldown or 15s minimum.
    const minimumAt = this.cached.status === "ready" && refresh ? (this.cached.fetchedAt ?? 0) + 15_000 : this.nextAt
    if (now < minimumAt) return this.cached
    const signal = this.controller.signal
    const task = this.load(connection, signal)
    this.pending = task
    try {
      return await task
    } finally {
      if (this.pending === task) this.pending = undefined
    }
  }

  private async load(
    connection: NonNullable<Awaited<ReturnType<CodexHost["active"]>>>,
    signal: AbortSignal,
  ): Promise<ProviderSnapshot> {
    const previous = this.cached
    const now = this.now()
    let snapshot: ProviderSnapshot
    let delay: number
    try {
      const { windows, resetCredits } = await fetchCodexUsage(await connection.resolve(), signal, this.request, now)
      if (signal.aborted) return { ...base, status: "unavailable", message: "Connection changed; refresh usage." }
      snapshot = {
        ...base,
        accountLabel: connection.label,
        status: "ready",
        message: windows.length ? "Account quota · private Codex endpoint" : "No quota windows reported.",
        fetchedAt: this.now(),
        windows,
        ...(resetCredits ? { resetCredits } : {}),
      }
      delay = 120_000
      this.failures = 0
    } catch (error) {
      if (signal.aborted) return { ...base, status: "unavailable", message: "Connection changed; refresh usage." }
      const failure =
        error instanceof UsageFailure ? error : new UsageFailure("unavailable", "Could not read Codex usage.")
      const authFailure = failure.status === "signed-out" || failure.status === "unsupported"
      // Discard old data on auth errors; stale values only survive transient failures for this account.
      snapshot = {
        ...previous,
        accountLabel: connection.label,
        status: failure.status,
        message: failure.message,
        retryAt: failure.retryAt,
        ...(authFailure ? { windows: [], fetchedAt: null, resetCredits: undefined } : {}),
      }
      delay = authFailure ? 300_000 : Math.min(900_000, 30_000 * 2 ** Math.min(this.failures++, 5))
      delay = Math.max(delay, (failure.retryAt ?? 0) - this.now())
    }
    // An in-flight request for the previous account may finish after a switch/unload.
    if (signal.aborted) return { ...base, status: "unavailable", message: "Connection changed; refresh usage." }
    this.cached = snapshot
    this.nextAt = this.now() + delay
    return snapshot
  }
}

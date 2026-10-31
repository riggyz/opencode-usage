import type { ProviderSnapshot, QuotaWindow } from "../model"

/** Only allowlisted subscription headers. Never inspect/copy prompts, body streams or auth headers. */
export function parseClaudeHeaders(headers: Headers): QuotaWindow[] {
  return (["5h", "7d"] as const).flatMap((lane) => {
    const raw = headers.get(`anthropic-ratelimit-unified-${lane}-utilization`)
    if (raw === null || raw.trim() === "") return []
    const fraction = Number(raw)
    if (!Number.isFinite(fraction) || fraction < 0) return []
    const reset = headers.get(`anthropic-ratelimit-unified-${lane}-reset`)
    const seconds = reset === null || reset.trim() === "" ? null : Number(reset)
    return [
      {
        id: lane,
        label: lane,
        usedPercent: fraction * 100,
        durationMs: lane === "5h" ? 18_000_000 : 604_800_000,
        resetsAt: seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      },
    ]
  })
}

export class ClaudeObserver {
  private observations = new Map<string, ProviderSnapshot>()
  readonly diagnostics = { requests: 0, responses: 0, bound: 0, quota: 0 }

  observe(key: string, accountLabel: string, headers: Headers, now = Date.now()) {
    const windows = parseClaudeHeaders(headers)
    if (!windows.length) return
    this.diagnostics.quota++
    this.observations.set(key, {
      provider: "claude",
      source: "claude-response-headers",
      accountLabel,
      status: "ready",
      message: "Quota observed on an OpenCode Claude response. Updates when Claude is used; no extra quota requests.",
      fetchedAt: now,
      retryAt: null,
      windows,
    })
    // Bound the process-local cache across account changes.
    if (this.observations.size > 20) this.observations.delete(this.observations.keys().next().value!)
  }

  read(key?: string, accountLabel = "OpenCode Anthropic connection"): ProviderSnapshot {
    if (key) {
      const snapshot = this.observations.get(key)
      if (snapshot) return snapshot
    }
    return {
      provider: "claude",
      source: "claude-response-headers",
      accountLabel,
      status: key ? "unavailable" : "signed-out",
      message: key
        ? "Waiting for subscription quota headers on a Claude response in OpenCode. No separate Claude Code session is required."
        : "No active Anthropic connection. Connect Claude in OpenCode to observe usage.",
      fetchedAt: null,
      retryAt: null,
      windows: [],
    }
  }
}

// Location plugin instances in the same server share numeric observations keyed by host credential ID.
export const claudeObserver = new ClaudeObserver()

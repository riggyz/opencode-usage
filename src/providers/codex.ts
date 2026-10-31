import { z } from "zod"
import { durationLabel, type QuotaWindow, type ProviderSnapshot } from "../model"

const Window = z.object({
  used_percent: z.number().finite(),
  limit_window_seconds: z.number().positive().nullish(),
  reset_at: z.number().nonnegative().nullish(),
})
const Limit = z.object({ primary_window: Window.nullish(), secondary_window: Window.nullish() })
const Payload = z.object({
  rate_limit: Limit.nullish(),
  additional_rate_limits: z
    .array(z.object({ limit_name: z.string(), metered_feature: z.string(), rate_limit: Limit }))
    .nullish(),
})

export function parseCodexUsage(value: unknown): QuotaWindow[] {
  const data = Payload.parse(value)
  const buckets = [
    { id: "codex", name: "", limit: data.rate_limit },
    ...(data.additional_rate_limits ?? []).map((item) => ({
      id: item.metered_feature,
      name: item.limit_name,
      limit: item.rate_limit,
    })),
  ]
  const windows = new Map<string, QuotaWindow>()
  for (const bucket of buckets) {
    for (const lane of ["primary", "secondary"] as const) {
      const window = bucket.limit?.[`${lane}_window`]
      if (!window) continue
      const durationMs = window.limit_window_seconds ? window.limit_window_seconds * 1000 : null
      const id = `${bucket.id}:${lane}`
      windows.set(id, {
        id,
        label: [bucket.name, durationLabel(durationMs, lane)].filter(Boolean).join(" · "),
        usedPercent: window.used_percent,
        durationMs,
        resetsAt: window.reset_at == null ? null : window.reset_at * 1000,
      })
    }
  }
  return [...windows.values()]
}

// Narrow structural host boundary, so tests need neither OpenCode nor real credentials.
export interface CodexHost {
  active(): Promise<{ key: string; label: string; resolve(): Promise<unknown> } | undefined>
}
const OAuth = z.object({
  type: z.literal("oauth"),
  methodID: z.enum(["chatgpt-browser", "chatgpt-headless", "chatgpt-token-sharing"]),
  access: z.string().min(1),
  expires: z.number(),
  metadata: z.object({ accountID: z.string().optional() }).optional(),
})

export class UsageFailure extends Error {
  constructor(
    readonly status: ProviderSnapshot["status"],
    message: string,
    readonly retryAt: number | null = null,
  ) {
    super(message)
  }
}

export function retryAfter(value: string | null, now: number): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(date, now) : null
}

export async function fetchCodexUsage(
  credential: unknown,
  signal: AbortSignal,
  request: typeof fetch = fetch,
  now = Date.now(),
): Promise<QuotaWindow[]> {
  const result = OAuth.safeParse(credential)
  if (!result.success) {
    const kind = z
      .object({ type: z.enum(["oauth", "key", "external"]), methodID: z.string().optional() })
      .safeParse(credential)
    const message =
      kind.success && kind.data.type === "key"
        ? "Active OpenAI connection uses an API key, not a Codex subscription login."
        : "No compatible OpenAI subscription connection is available."
    throw new UsageFailure("unsupported", message)
  }
  const auth = result.data
  if (auth.expires <= now) throw new UsageFailure("signed-out", "Codex connection expired. Reconnect through OpenCode.")
  const headers: Record<string, string> = { Authorization: `Bearer ${auth.access}`, Accept: "application/json" }
  if (auth.metadata?.accountID) headers["ChatGPT-Account-Id"] = auth.metadata.accountID
  const response = await request("https://chatgpt.com/backend-api/wham/usage", {
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    redirect: "error",
  })
  if ((response.status === 401 || response.status === 403) && auth.methodID === "chatgpt-token-sharing")
    throw new UsageFailure(
      "unsupported",
      `Codex quota endpoint rejected this ChatGPT token-sharing login (HTTP ${response.status}). Your inference login is unchanged.`,
    )
  if (response.status === 401)
    throw new UsageFailure("signed-out", "Codex rejected this connection. Reconnect through OpenCode.")
  if (response.status === 403) throw new UsageFailure("unsupported", "This connection cannot read Codex quota.")
  if (response.status === 429) {
    throw new UsageFailure(
      "rate-limited",
      "Codex usage requests are rate limited.",
      retryAfter(response.headers.get("Retry-After"), now),
    )
  }
  if (!response.ok)
    throw new UsageFailure(
      "unavailable",
      "Codex usage service is unavailable.",
      retryAfter(response.headers.get("Retry-After"), now),
    )
  try {
    return parseCodexUsage(await response.json())
  } catch {
    throw new UsageFailure("unavailable", "Codex returned an unrecognized usage response.")
  }
}

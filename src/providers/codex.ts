import { z } from "zod"
import { durationLabel, type QuotaWindow, type ProviderSnapshot, type ResetCredits } from "../model"

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
  rate_limit_reset_credits: z.object({ available_count: z.number().int().nonnegative() }).nullish(),
})
// Only availability and expiry; credit IDs and referral profile fields are dropped.
const CreditList = z.object({
  credits: z.array(
    z.object({ status: z.string(), expires_at: z.string().nullish(), reset_type: z.string().optional() }),
  ),
})

export function parseCreditGroups(value: unknown): ResetCredits["groups"] {
  const result = CreditList.safeParse(value)
  if (!result.success) return undefined
  const groups = new Map<string, { type: string; available: number; expirations: (number | null)[] }>()
  for (const credit of result.data.credits) {
    if (credit.status !== "available") continue
    const type = credit.reset_type || "Reset"
    const group = groups.get(type) ?? { type, available: 0, expirations: [] }
    const expiry = credit.expires_at ? Date.parse(credit.expires_at) : NaN
    group.available++
    group.expirations.push(Number.isFinite(expiry) ? expiry : null)
    groups.set(type, group)
  }
  return [...groups.values()].sort((a, b) => a.type.localeCompare(b.type))
}

export function parseResetCreditsSummary(value: unknown): number | undefined {
  const result = Payload.safeParse(value)
  return result.success ? result.data.rate_limit_reset_credits?.available_count : undefined
}

export function earliestCreditExpiry(value: unknown, now: number): number | null {
  const result = CreditList.safeParse(value)
  if (!result.success) return null
  const expiries = result.data.credits
    .filter((credit) => credit.status === "available" && credit.expires_at)
    .map((credit) => Date.parse(credit.expires_at!))
    .filter((at) => Number.isFinite(at) && at > now)
  return expiries.length ? Math.min(...expiries) : null
}

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
): Promise<{ windows: QuotaWindow[]; resetCredits?: ResetCredits }> {
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
  let body: unknown
  let windows: QuotaWindow[]
  try {
    body = await response.json()
    windows = parseCodexUsage(body)
  } catch {
    throw new UsageFailure("unavailable", "Codex returned an unrecognized usage response.")
  }
  const available = parseResetCreditsSummary(body)
  if (available === undefined) return { windows }
  if (available === 0) return { windows, resetCredits: { available, expiresAt: null } }
  // Expiry is optional detail; failing to read it never hides the count or fails usage.
  let expiresAt: number | null = null
  let groups: ResetCredits["groups"]
  try {
    const details = await request("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      redirect: "error",
    })
    if (details.ok) {
      const body: unknown = await details.json()
      expiresAt = earliestCreditExpiry(body, now)
      const parsed = parseCreditGroups(body)
      // Do not present a partial/type breakdown as the authoritative summary.
      if (parsed?.reduce((sum, group) => sum + group.available, 0) === available) groups = parsed
    }
  } catch {}
  return { windows, resetCredits: { available, expiresAt, ...(groups ? { groups } : {}) } }
}

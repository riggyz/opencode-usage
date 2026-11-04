import { z } from "zod"

// All internal timestamps are milliseconds. Percentage always means USED.
export const QuotaWindow = z.object({
  id: z.string(),
  label: z.string(),
  usedPercent: z.number().finite(),
  durationMs: z.number().positive().nullable(),
  resetsAt: z.number().finite().nullable(),
})
export type QuotaWindow = z.infer<typeof QuotaWindow>

// Earned Codex rate-limit resets. Absent means not reported, never zero.
export const ResetCredits = z.object({
  available: z.number().int().nonnegative(),
  expiresAt: z.number().finite().nullable(),
})
export type ResetCredits = z.infer<typeof ResetCredits>

export const ProviderSnapshot = z.object({
  provider: z.enum(["codex", "claude"]),
  source: z.enum(["codex-oauth-private", "claude-code-statusline", "claude-response-headers"]),
  accountLabel: z.string(),
  status: z.enum(["ready", "signed-out", "unsupported", "unavailable", "rate-limited", "disabled"]),
  message: z.string(),
  fetchedAt: z.number().finite().nullable(),
  retryAt: z.number().finite().nullable(),
  windows: z.array(QuotaWindow),
  resetCredits: ResetCredits.optional(),
})
export type ProviderSnapshot = z.infer<typeof ProviderSnapshot>

export const Snapshot = z.object({ providers: z.array(ProviderSnapshot) })
export type Snapshot = z.infer<typeof Snapshot>

export function durationLabel(ms: number | null, fallback: string): string {
  if (ms === null) return fallback
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  return `${Math.round(ms / 60_000)}m`
}

function countdown(at: number, now: number): string | null {
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes <= 0) return null
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function resetLabel(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return "Reset time unavailable"
  const remaining = countdown(resetsAt, now)
  return remaining ? `Resets in ${remaining}` : "Reset pending verification"
}

export function resetCreditsLabel(credits: ResetCredits | undefined, now: number) {
  if (!credits?.available) return undefined
  const count = `${credits.available} ${credits.available === 1 ? "reset" : "resets"}`
  const remaining = credits.expiresAt === null ? null : countdown(credits.expiresAt, now)
  return { count, expiry: remaining ? `Earliest exp in ${remaining}` : undefined }
}

export function isStale(snapshot: ProviderSnapshot, now: number): boolean {
  return snapshot.status !== "ready" || snapshot.fetchedAt === null || now - snapshot.fetchedAt > 5 * 60_000
}

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

// Saved provider resets. Absent means not reported, never zero.
export const ResetCredits = z.object({
  available: z.number().int().nonnegative(),
  expiresAt: z.number().finite().nullable(),
  fetchedAt: z.number().finite().optional(),
  groups: z
    .array(
      z.object({
        type: z.string(),
        available: z.number().int().positive(),
        expirations: z.array(z.number().finite().nullable()),
        usableNow: z.boolean().optional(),
      }),
    )
    .optional(),
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
  resetInventoryStatus: z.enum(["ready", "unavailable", "signed-out", "rate-limited"]).optional(),
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
  return remaining ?? "Reset pending"
}

export function resetChipLabel(available: number, expirations: (number | null)[], now: number): string {
  const count = `${available} ${available === 1 ? "reset" : "resets"}`
  const dates = expirations.filter((at): at is number => at !== null)
  if (!dates.length) return count
  return `${count} · ${countdown(Math.min(...dates), now) ?? "Expiry pending"}`
}

export function creditExpiryLabel(at: number | null, now: number): string {
  if (at === null) return "Expiration unavailable"
  const remaining = countdown(at, now)
  return remaining ? `Expires in ${remaining}` : "Expiration pending refresh"
}

export function resetSummaryLabel(credits: ResetCredits | undefined, now: number): string | undefined {
  if (!credits?.available) return undefined
  const expirations = [credits.expiresAt, ...(credits.groups ?? []).flatMap((group) => group.expirations)]
  return resetChipLabel(credits.available, expirations, now)
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

import { readFile, stat } from "node:fs/promises"
import { z } from "zod"
import type { ProviderSnapshot, QuotaWindow } from "../model"

const Window = z.object({ used_percentage: z.number().finite(), resets_at: z.number().nonnegative().optional() })
const Limits = z.object({ five_hour: Window.nullish(), seven_day: Window.nullish() })
const Statusline = z.object({ rate_limits: Limits.nullish() })

export const ClaudeFeed = z.object({
  version: z.literal(1),
  capturedAt: z.number().nonnegative(),
  rate_limits: Limits,
})
export type ClaudeFeed = z.infer<typeof ClaudeFeed>

/** Allowlist numeric quota data. Do not forward arbitrary status-line/session fields. */
export function sanitizeStatusline(input: unknown, now: number): ClaudeFeed {
  const data = Statusline.parse(input)
  return { version: 1, capturedAt: now, rate_limits: data.rate_limits ?? {} }
}

export function claudeWindows(feed: ClaudeFeed): QuotaWindow[] {
  return (["five_hour", "seven_day"] as const).flatMap((id) => {
    const value = feed.rate_limits[id]
    if (!value) return []
    return [
      {
        id,
        label: id === "five_hour" ? "5h" : "7d",
        usedPercent: value.used_percentage,
        durationMs: id === "five_hour" ? 18_000_000 : 604_800_000,
        resetsAt: value.resets_at === undefined ? null : value.resets_at * 1000,
      },
    ]
  })
}

export async function readClaudeFeed(path: string | undefined, now = Date.now()): Promise<ProviderSnapshot> {
  const base: ProviderSnapshot = {
    provider: "claude",
    source: "claude-code-statusline",
    accountLabel: "Claude Code feed (account unverified)",
    status: "disabled",
    message: "Optional Claude Code status-line bridge is not configured.",
    fetchedAt: null,
    retryAt: null,
    windows: [],
  }
  if (!path) return base
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > 16_384) throw new Error("Invalid feed")
    const feed = ClaudeFeed.parse(JSON.parse(await readFile(path, "utf8")))
    if (feed.capturedAt > now + 60_000) throw new Error("Invalid capture time")
    const windows = claudeWindows(feed)
    return {
      ...base,
      status: "ready",
      message: "Claude Code observation · not a live OpenCode feed",
      fetchedAt: feed.capturedAt,
      windows,
    }
  } catch {
    return { ...base, status: "unavailable", message: "Waiting for a valid Claude Code quota feed." }
  }
}

import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { halfRingPath, ringWindows, tooltipWindows, weeklyTrack } from "../src/presentation"
import { resetCreditsLabel, type ProviderSnapshot, type QuotaWindow } from "../src/model"

const five: QuotaWindow = { id: "codex:primary", label: "5h", usedPercent: 56, durationMs: 18_000_000, resetsAt: null }
const week: QuotaWindow = { ...five, id: "codex:secondary", label: "7d", usedPercent: 35, durationMs: 604_800_000 }
const quota = (provider: "claude" | "codex", windows: QuotaWindow[]): ProviderSnapshot => ({
  provider,
  source: provider === "codex" ? "codex-oauth-private" : "claude-response-headers",
  accountLabel: "private account label",
  status: "ready",
  message: "private metadata",
  fetchedAt: 1,
  retryAt: null,
  windows,
})

test("maps reported duration to outer five-hour and inner weekly tracks, not array order", () => {
  expect(ringWindows(quota("claude", [week, five]))).toEqual({ fiveHour: five, sevenDay: week })
  expect(ringWindows(quota("codex", [week]))).toEqual({ fiveHour: undefined, sevenDay: week })
  expect(ringWindows(undefined)).toEqual({ fiveHour: undefined, sevenDay: undefined })
})

test("doesn't substitute a model-specific Codex bucket for the account's missing window", () => {
  const extra = { ...five, id: "extra-model:primary", label: "Extra model · 5h" }
  expect(ringWindows(quota("codex", [week, extra])).fiveHour).toBeUndefined()
  expect(tooltipWindows(quota("codex", [week, extra]))).toContain(extra)
})

test("orders the simple tooltip Claude five-hour first and Codex weekly first", () => {
  expect(tooltipWindows(quota("claude", [week, five]))).toEqual([five, week])
  expect(tooltipWindows(quota("codex", [five, week]))).toEqual([week, five])
})

test("Codex weekly-only arc fills both tracks, without expanding Claude or inventing a window", () => {
  const expanded = weeklyTrack(quota("codex", [week]))
  expect(expanded.radius + expanded.strokeWidth / 2).toBe(8 + 1.5 / 2)
  expect(expanded.radius - expanded.strokeWidth / 2).toBe(4.75 - 1.5 / 2)
  expect(weeklyTrack(quota("codex", [five, week]))).toEqual({ radius: 4.75, strokeWidth: 1.5 })
  expect(weeklyTrack(quota("claude", [week]))).toEqual({ radius: 4.75, strokeWidth: 1.5 })
  expect(weeklyTrack(undefined)).toEqual({ radius: 4.75, strokeWidth: 1.5 })
})

test("split paths place Claude above and Codex below the center with a visible gap", () => {
  for (const radius of [8, 4.75]) {
    expect(halfRingPath("claude", radius)).toMatch(/^M [\d.]+ 8\.9 A/)
    expect(halfRingPath("codex", radius)).toMatch(/^M [\d.]+ 11\.1 A/)
    expect(halfRingPath("claude", radius)).not.toContain("NaN")
  }
})

test("reset-credit tooltip shows a count and earliest expiry only when credits exist", () => {
  expect(resetCreditsLabel(undefined, 0)).toBeUndefined()
  expect(resetCreditsLabel({ available: 0, expiresAt: null }, 0)).toBeUndefined()
  expect(resetCreditsLabel({ available: 1, expiresAt: null }, 0)).toEqual({
    count: "1 reset",
    expiry: undefined,
  })
  expect(resetCreditsLabel({ available: 2, expiresAt: 93_600_000 }, 0)).toEqual({
    count: "2 resets",
    expiry: "Earliest exp in 1d 2h",
  })
  expect(resetCreditsLabel({ available: 2, expiresAt: 10 }, 20)?.expiry).toBeUndefined()
})

test("toolbar/tooltip code contains no account labels, absolute timestamps or usage instructions", async () => {
  const gui = await readFile(new URL("../src/gui.tsx", import.meta.url), "utf8")
  expect(gui).not.toContain("accountLabel")
  expect(gui).not.toContain("toLocaleString")
  expect(gui).not.toContain("Outer ring")
  expect(gui).not.toContain("Click to refresh")
})

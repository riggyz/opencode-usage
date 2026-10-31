import type { ProviderSnapshot, QuotaWindow } from "./model"

export function ringWindows(quota: ProviderSnapshot | undefined) {
  // Extra Codex model buckets aren't the account's primary quota pool.
  const windows = quota?.windows.filter((window) => quota.provider !== "codex" || window.id.startsWith("codex:")) ?? []
  return {
    fiveHour: windows.find((window) => window.durationMs === 18_000_000),
    sevenDay: windows.find((window) => window.durationMs === 604_800_000),
  }
}

export function tooltipWindows(quota: ProviderSnapshot | undefined): QuotaWindow[] {
  const preferred = quota?.provider === "codex" ? [604_800_000, 18_000_000] : [18_000_000, 604_800_000]
  const rank = (window: QuotaWindow) => {
    const index = preferred.indexOf(window.durationMs ?? -1)
    return index < 0 ? preferred.length : index
  }
  return [...(quota?.windows ?? [])].sort((a, b) => rank(a) - rank(b))
}

export function weeklyTrack(quota: ProviderSnapshot | undefined) {
  const windows = ringWindows(quota)
  const expanded = quota?.provider === "codex" && !!windows.sevenDay && !windows.fiveHour
  // Preserve the exact outer/inner bounds of the normal two-track drawing.
  return expanded ? { radius: 6.375, strokeWidth: 4.75 } : { radius: 4.75, strokeWidth: 1.5 }
}

export function halfRingPath(provider: ProviderSnapshot["provider"], radius: number): string {
  const gap = 1.1
  const x = Math.sqrt(radius * radius - gap * gap)
  const left = (10 - x).toFixed(3)
  const right = (10 + x).toFixed(3)
  const y = provider === "claude" ? 10 - gap : 10 + gap
  const [start, end] = provider === "claude" ? [left, right] : [right, left]
  return `M ${start} ${y} A ${radius} ${radius} 0 0 1 ${end} ${y}`
}

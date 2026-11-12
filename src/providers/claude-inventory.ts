import { z } from "zod"
import type { ResetCredits } from "../model"
import { retryAfter } from "./codex"

const Bound = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)))
  .nullish()
const Grant = z.object({
  resets_left: z.number().int().min(0).max(50),
  resets_total: z.number().int().nonnegative().optional(),
  starts_at: Bound,
  ends_at: Bound,
  paused: z.boolean(),
  usable_now: z.boolean().optional(),
  clears: z.array(z.string().max(100)).max(20).optional(),
})
const Inventory = z.object({
  cedar_ember: z
    .object({ eligible: z.boolean(), grants: z.array(z.unknown()).max(200), ineligible_reason: z.unknown().optional() })
    .nullish(),
})

/** Drop identifiers/redemption handles and arbitrary grant prose at the boundary. */
export function parseClaudeInventory(body: unknown, now: number): ResetCredits | undefined {
  const parsed = Inventory.safeParse(body)
  if (!parsed.success || !parsed.data.cedar_ember?.eligible) return undefined
  const groups = new Map<string, NonNullable<ResetCredits["groups"]>[number]>()
  let available = 0
  for (const raw of parsed.data.cedar_ember.grants) {
    const result = Grant.safeParse(raw)
    if (!result.success) return undefined
    const grant = result.data
    if (grant.resets_total !== undefined && grant.resets_left > grant.resets_total) return undefined
    if (grant.paused || !grant.resets_left) continue
    if (grant.starts_at && Date.parse(grant.starts_at) > now) continue
    const expiry = grant.ends_at ? Date.parse(grant.ends_at) : null
    if (expiry !== null && expiry <= now) continue
    available += grant.resets_left
    if (available > 50) return undefined
    // Scope comes from the reported cleared windows, never guesses based on a grant ID/label.
    const clears = [...new Set(grant.clears ?? [])].sort()
    const type = clears.length ? clears.join(" + ") : "Reset scope unavailable"
    const key = JSON.stringify([type, grant.usable_now])
    const group = groups.get(key) ?? {
      type,
      available: 0,
      expirations: [],
      ...(grant.usable_now !== undefined ? { usableNow: grant.usable_now } : {}),
    }
    group.available += grant.resets_left
    group.expirations.push(...Array<number | null>(grant.resets_left).fill(expiry))
    groups.set(key, group)
  }
  const dates = [...groups.values()].flatMap((group) => group.expirations).filter((at): at is number => at !== null)
  return {
    available,
    expiresAt: dates.length ? Math.min(...dates) : null,
    fetchedAt: now,
    groups: [...groups.values()],
  }
}

const OAuth = z.object({ type: z.literal("oauth"), access: z.string().min(1), expires: z.number() })
export type ClaudeInventoryState = {
  credits?: ResetCredits
  status: "ready" | "unavailable" | "signed-out" | "rate-limited"
}

/** Opt-in, demand-driven reader. No timers, credential persistence or independent refresh. */
export class ClaudeInventory {
  readonly diagnostics: {
    httpStatus: number | null
    inventoryPresent: boolean
    eligible: boolean | null
    surfaceRestricted: boolean
    grantRecords: number | null
  } = {
    httpStatus: null,
    inventoryPresent: false,
    eligible: null,
    surfaceRestricted: false,
    grantRecords: null,
  }
  private key: string | undefined
  private state: ClaudeInventoryState = { status: "unavailable" }
  private nextAt = 0
  private pending: Promise<ClaudeInventoryState> | undefined
  private controller = new AbortController()
  private stopped = false

  constructor(
    private request: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  dispose() {
    this.stopped = true
    this.controller.abort()
  }

  async read(key: string, resolve: () => Promise<unknown>): Promise<ClaudeInventoryState> {
    if (this.stopped) return { status: "unavailable" }
    if (this.key !== key) {
      this.controller.abort()
      this.controller = new AbortController()
      this.key = key
      this.state = { status: "unavailable" }
      this.nextAt = 0
      this.pending = undefined
      Object.assign(this.diagnostics, {
        httpStatus: null,
        inventoryPresent: false,
        eligible: null,
        surfaceRestricted: false,
        grantRecords: null,
      })
    }
    if (this.pending) return this.pending
    if (this.now() < this.nextAt) return this.state
    const task = this.load(resolve, this.controller.signal)
    this.pending = task
    try {
      return await task
    } finally {
      if (this.pending === task) this.pending = undefined
    }
  }

  private async load(resolve: () => Promise<unknown>, signal: AbortSignal): Promise<ClaudeInventoryState> {
    let delay = 300_000
    let state: ClaudeInventoryState = { ...this.state, status: "unavailable" }
    try {
      const auth = OAuth.safeParse(await resolve())
      if (signal.aborted) return { status: "unavailable" }
      if (!auth.success || auth.data.expires <= this.now()) {
        state = { status: "signed-out" }
      } else {
        const response = await this.request("https://api.anthropic.com/api/oauth/usage?cedar_ember=1", {
          method: "GET",
          redirect: "error",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${auth.data.access}`,
            Accept: "application/json",
            "anthropic-beta": "oauth-2025-04-20",
            // Compatibility identity observed in CodexBar #3895; no local CLI is launched.
            "User-Agent": "claude-cli/2.1.280 (external, cli)",
            "Content-Type": "application/json",
          },
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        })
        if (signal.aborted) return { status: "unavailable" }
        this.diagnostics.httpStatus = response.status
        if (response.status === 401 || response.status === 403) state = { status: "signed-out" }
        else if (response.status === 429) {
          state = { ...this.state, status: "rate-limited" }
          delay = Math.max(300_000, (retryAfter(response.headers.get("Retry-After"), this.now()) ?? 0) - this.now())
        } else if (response.ok) {
          const body: unknown = await response.json()
          if (signal.aborted) return { status: "unavailable" }
          const shape = Inventory.safeParse(body)
          this.diagnostics.inventoryPresent = shape.success && !!shape.data.cedar_ember
          this.diagnostics.eligible = shape.success ? (shape.data.cedar_ember?.eligible ?? null) : null
          this.diagnostics.surfaceRestricted = shape.success && shape.data.cedar_ember?.ineligible_reason === "surface"
          this.diagnostics.grantRecords = shape.success ? (shape.data.cedar_ember?.grants.length ?? null) : null
          const credits = parseClaudeInventory(body, this.now())
          state = credits ? { status: "ready", credits } : { status: "unavailable" }
        }
      }
    } catch {
      // Never expose provider bodies, credentials or raw transport errors.
    }
    if (signal.aborted) return { status: "unavailable" }
    this.state = state
    this.nextAt = this.now() + delay
    return state
  }
}

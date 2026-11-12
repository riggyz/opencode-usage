import { expect, test } from "bun:test"
import { ClaudeInventory, parseClaudeInventory } from "../src/providers/claude-inventory"
import { resetChipLabel } from "../src/model"
import type { Snapshot } from "../src/model"
import plugin from "../src/index"

const now = Date.parse("2026-11-12T00:00:00Z")
const auth = { type: "oauth", access: "synthetic-secret", refresh: "never-send", expires: now + 3600000 }
const grant = {
  resets_left: 1,
  resets_total: 1,
  paused: false,
  clears: ["five_hour", "seven_day"],
  ends_at: "2026-12-01T00:00:00Z",
}
const body = {
  cedar_ember: {
    eligible: true,
    grants: [
      { ...grant, id: "redemption-handle", label: "private prose", usable_now: false },
      { ...grant, clears: ["seven_day_fable"], resets_left: 2, resets_total: 2 },
    ],
  },
}

test("Claude inventory preserves cleared scope, remaining counts, gating and expirations without handles", () => {
  const result = parseClaudeInventory(body, now)
  expect(result?.available).toBe(3)
  expect(result?.groups?.map((group) => [group.type, group.available, group.usableNow])).toEqual([
    ["five_hour + seven_day", 1, false],
    ["seven_day_fable", 2, undefined],
  ])
  expect(result?.groups?.[1]?.expirations).toHaveLength(2)
  expect(result?.fetchedAt).toBe(now)
  expect(JSON.stringify(result)).not.toContain("redemption-handle")
  expect(JSON.stringify(result)).not.toContain("private prose")
})

test("absent, ineligible or malformed inventory is not zero; eligible empty inventory is zero", () => {
  for (const value of [
    {},
    { cedar_ember: null },
    { cedar_ember: { eligible: false, grants: [] } },
    { cedar_ember: { eligible: true, grants: [{ ...grant, ends_at: "invalid" }] } },
    { cedar_ember: { eligible: true, grants: [{ ...grant, paused: undefined }] } },
  ])
    expect(parseClaudeInventory(value, now)).toBeUndefined()
  expect(parseClaudeInventory({ cedar_ember: { eligible: true, grants: [] } }, now)?.available).toBe(0)
})

test("expired, future, paused and used grants are excluded", () => {
  const grants = [
    { ...grant, paused: true },
    { ...grant, resets_left: 0 },
    { ...grant, ends_at: "2020-01-01T00:00:00Z" },
    { ...grant, starts_at: "2030-01-01T00:00:00Z" },
  ]
  expect(parseClaudeInventory({ cedar_ember: { eligible: true, grants } }, now)?.available).toBe(0)
})

test("surface rejection is distinguished from zero without exposing provider error text", async () => {
  const reader = new ClaudeInventory(
    (async (_url: string | URL | Request) =>
      Response.json({
        cedar_ember: { eligible: false, ineligible_reason: "surface", grants: [] },
        error: "RAW PROVIDER TEXT",
      })) as typeof fetch,
    () => now,
  )
  expect(await reader.read("a", async () => auth)).toEqual({ status: "unavailable" })
  expect(reader.diagnostics).toMatchObject({
    httpStatus: 200,
    eligible: false,
    surfaceRestricted: true,
    grantRecords: 0,
  })
  expect(JSON.stringify(reader.diagnostics)).not.toContain("RAW PROVIDER TEXT")
  reader.dispose()
})

test("Claude reader coalesces, throttles, uses host auth and never sends refresh tokens", async () => {
  let calls = 0
  const reader = new ClaudeInventory(
    (async (url, init) => {
      calls++
      expect(url).toBe("https://api.anthropic.com/api/oauth/usage?cedar_ember=1")
      expect(init?.method).toBe("GET")
      expect(init?.redirect).toBe("error")
      expect(init?.cache).toBe("no-store")
      expect(init?.headers).toMatchObject({
        "User-Agent": "claude-cli/2.1.280 (external, cli)",
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      })
      expect(JSON.stringify(init)).not.toContain("never-send")
      return Response.json(body)
    }) as typeof fetch,
    () => now,
  )
  const results = await Promise.all([reader.read("a", async () => auth), reader.read("a", async () => auth)])
  expect(results[0].credits?.available).toBe(3)
  expect(calls).toBe(1)
  await reader.read("a", async () => auth)
  expect(calls).toBe(1)
  await reader.read("b", async () => auth)
  expect(calls).toBe(2)
  reader.dispose()
  expect((await reader.read("b", async () => auth)).credits).toBeUndefined()
})

test("auth errors clear old inventory; Retry-After is honored and errors are sanitized", async () => {
  let time = now
  let calls = 0
  const reader = new ClaudeInventory(
    (async (_url: string | URL | Request) => {
      calls++
      if (calls === 1) return Response.json(body)
      return new Response("RAW SECRET", { status: calls === 2 ? 429 : 401, headers: { "Retry-After": "600" } })
    }) as typeof fetch,
    () => time,
  )
  await reader.read("a", async () => ({ ...auth, expires: now + 86400000 }))
  time += 300000
  const limited = await reader.read("a", async () => ({ ...auth, expires: now + 86400000 }))
  expect(limited.status).toBe("rate-limited")
  expect(limited.credits?.fetchedAt).toBe(now)
  time += 300000
  await reader.read("a", async () => auth)
  expect(calls).toBe(2)
  time += 300000
  const denied = await reader.read("a", async () => ({ ...auth, expires: now + 86400000 }))
  expect(denied).toEqual({ status: "signed-out" })
  expect(JSON.stringify(denied)).not.toContain("RAW SECRET")
})

test("reset chip includes the group's earliest expiry inline without inventing missing dates", () => {
  expect(resetChipLabel(2, [now + 120000, now + 60000], now)).toBe("2 resets · 1m")
  expect(resetChipLabel(1, [null], now)).toBe("1 reset")
  expect(resetChipLabel(2, [now - 1, now + 60000], now)).toBe("2 resets · Expiry pending")
  expect(resetChipLabel(2, [now + (18 * 24 + 6) * 3600000], now)).toBe("2 resets · 18d 6h")
})

test("unavailable inventory returns strict JSON without altering passive snapshot freshness", async () => {
  let snapshot!: (input: {}) => Promise<Snapshot>
  const cleanup = await plugin.setup({
    options: { codex: false, claudeResetInventory: true },
    storage: { get: async () => undefined, set: async () => {} },
    integration: {
      connection: {
        active: async () => ({ type: "credential", id: "json-test", label: "Test" }),
        resolve: async () => undefined,
      },
    },
    session: { hook: async () => ({ dispose: async () => {} }) },
    rpc: {
      register: async (_contract: unknown, handlers: { snapshot: typeof snapshot }) => {
        snapshot = handlers.snapshot
        return { dispose: async () => {} }
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0])
  try {
    const value = await snapshot({})
    expect(value).toEqual(JSON.parse(JSON.stringify(value)))
    expect(value.providers[0]?.resetInventoryStatus).toBe("signed-out")
    expect(value.providers[0]?.fetchedAt).toBeNull()
    expect(value.providers[0]?.resetCredits).toBeUndefined()
  } finally {
    await cleanup?.()
  }
})

test("an old account request cannot install inventory after switching accounts", async () => {
  let finish!: (response: Response) => void
  let started!: () => void
  const begin = new Promise<void>((resolve) => {
    started = resolve
  })
  let calls = 0
  const reader = new ClaudeInventory(
    (async (_url: string | URL | Request) => {
      if (++calls === 1) {
        started()
        return new Promise<Response>((resolve) => {
          finish = resolve
        })
      }
      return Response.json({ cedar_ember: { eligible: true, grants: [] } })
    }) as typeof fetch,
    () => now,
  )
  const old = reader.read("a", async () => auth)
  await begin
  expect((await reader.read("b", async () => auth)).credits?.available).toBe(0)
  finish(Response.json(body))
  expect((await old).credits).toBeUndefined()
  expect((await reader.read("b", async () => auth)).credits?.available).toBe(0)
  reader.dispose()
})

import { expect, test } from "bun:test"
import { SnapshotCache } from "../src/snapshot-cache"
import { SharedUsage, type UsageView } from "../src/usage-state"
import type { ProviderSnapshot, Snapshot } from "../src/model"

const quota: ProviderSnapshot = {
  provider: "claude",
  source: "claude-response-headers",
  accountLabel: "Test Claude",
  status: "ready",
  message: "Observed quota",
  fetchedAt: Date.now() - 10_000,
  retryAt: null,
  windows: [{ id: "5h", label: "5h", usedPercent: 56, resetsAt: Date.now() + 60_000, durationMs: 18_000_000 }],
}
const snapshot: Snapshot = { providers: [quota] }

test("views keep the last global snapshot while a refresh is pending or offline", async () => {
  let release!: (value: Snapshot) => void
  let calls = 0
  const states: UsageView[] = []
  const usage = new SharedUsage(
    () => {
      calls++
      return new Promise((resolve) => {
        release = resolve
      })
    },
    snapshot,
    (state) => states.push(state),
  )
  const first = usage.refresh()
  const second = usage.refresh()
  expect(calls).toBe(1)
  expect(usage.state.snapshot).toBe(snapshot)
  expect(states[0]?.snapshot).toBe(snapshot)
  release({ providers: [{ ...quota, windows: [{ ...quota.windows[0]!, usedPercent: 57 }] }] })
  await Promise.all([first, second])
  expect(usage.state.snapshot?.providers[0]?.windows[0]?.usedPercent).toBe(57)
  expect(states.every((state) => state.snapshot !== undefined)).toBe(true)
  const offline = new SharedUsage(
    async () => {
      throw new Error("offline")
    },
    usage.state.snapshot,
    () => {},
  )
  await offline.refresh()
  expect(offline.state.offline).toBe(true)
  expect(offline.state.snapshot).toBe(usage.state.snapshot)
})

test("disposing a global controller rejects late results without clearing its cached snapshot", async () => {
  let release!: (value: Snapshot) => void
  const states: UsageView[] = []
  const usage = new SharedUsage(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
    snapshot,
    (state) => states.push(state),
  )
  const request = usage.refresh()
  usage.dispose()
  release({ providers: [] })
  await request
  expect(states).toHaveLength(1)
  expect(usage.state.snapshot).toBe(snapshot)
})

test("account snapshots survive new locations and reloads without changing their observation time", async () => {
  const values = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: ProviderSnapshot) => {
      values.set(key, value)
    },
    remove: async (key: string) => {
      values.delete(key)
    },
  }
  const firstLocation = new SnapshotCache(storage)
  await firstLocation.write("account-a", quota)
  const otherLocation = new SnapshotCache(storage)
  const restored = await otherLocation.read("claude", "account-a")
  expect(restored).toEqual(quota)
  expect(restored?.fetchedAt).toBe(quota.fetchedAt)
  expect(await otherLocation.read("claude", "account-b")).toBeUndefined()
  expect(await otherLocation.read("codex", "account-a")).toBeUndefined()
  await otherLocation.write("account-a", { ...quota, fetchedAt: quota.fetchedAt! - 1000 })
  expect((await firstLocation.read("claude", "account-a"))?.fetchedAt).toBe(quota.fetchedAt)
})

test("persistent snapshots strip unknown properties and don't retain auth failures", async () => {
  let saved: unknown
  let removed = false
  const cache = new SnapshotCache({
    get: async () => undefined,
    set: async (_key, value) => {
      saved = value
    },
    remove: async () => {
      removed = true
    },
  })
  await cache.write("a", { ...quota, accessToken: "must-not-persist" } as ProviderSnapshot)
  expect(JSON.stringify(saved)).not.toContain("must-not-persist")
  saved = undefined
  await cache.write("a", { ...quota, status: "signed-out" })
  expect(saved).toBeUndefined()
  expect(removed).toBe(true)
})

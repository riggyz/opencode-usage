import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CodexCollector } from "../src/collector"
import { fetchCodexUsage, parseCodexUsage, retryAfter, type CodexHost } from "../src/providers/codex"
import { readClaudeFeed, sanitizeStatusline } from "../src/providers/claude"
import { writeStatusline } from "../scripts/claude-statusline"
import { ClaudeObserver, parseClaudeHeaders } from "../src/providers/claude-observer"
import plugin from "../src/index"
import type { Snapshot } from "../src/model"
import { codexHost, listQuotaConnections, type OpenAIConnections } from "../src/connections"
import { isStale, resetLabel } from "../src/model"

const now = 1_800_000_000_000
const credential = {
  type: "oauth",
  methodID: "chatgpt-browser",
  access: "fake-secret",
  refresh: "never-send",
  expires: now + 3_600_000,
  metadata: { accountID: "test-account" },
}
const payload = {
  rate_limit: { primary_window: { used_percent: 23.5, limit_window_seconds: 18_000, reset_at: now / 1000 + 100 } },
}
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } })
const request = (fn: (url: string | URL | Request, init?: RequestInit) => Response | Promise<Response>) =>
  fn as typeof fetch
const connection = (key = "a", auth: unknown = credential) => ({ key, label: key, resolve: async () => auth })

describe("Codex payload normalization", () => {
  test("uses authoritative seconds, raw percent, and dynamic duration", () => {
    expect(parseCodexUsage(payload)).toEqual([
      { id: "codex:primary", label: "5h", usedPercent: 23.5, durationMs: 18_000_000, resetsAt: now + 100_000 },
    ])
  })
  test("missing windows are absent, not zero", () => {
    expect(parseCodexUsage({ rate_limit: null })).toEqual([])
    expect(
      parseCodexUsage({ rate_limit: { secondary_window: { used_percent: 102, reset_at: null } } })[0],
    ).toMatchObject({ label: "secondary", usedPercent: 102, durationMs: null, resetsAt: null })
  })
  test("preserves independent model buckets", () => {
    const windows = parseCodexUsage({
      ...payload,
      additional_rate_limits: [{ metered_feature: "extra", limit_name: "Extra", rate_limit: payload.rate_limit }],
    })
    expect(windows.map((window) => window.id)).toEqual(["codex:primary", "extra:primary"])
  })
  test("rejects invalid percentages rather than silently zeroing", () => {
    expect(() => parseCodexUsage({ rate_limit: { primary_window: { used_percent: "45" } } })).toThrow()
  })
})

test("explicit quota selection resolves a saved connection without activating it", async () => {
  const items = [
    { type: "credential", id: "inference", label: "Inference", method: "oauth" },
    { type: "credential", id: "quota", label: "Quota", method: "oauth" },
  ] as unknown as Awaited<ReturnType<OpenAIConnections["list"]>>
  const resolved: string[] = []
  const connections: OpenAIConnections = {
    active: async () => items[0],
    list: async () => items,
    resolve: async (item) => {
      const id = item.type === "credential" ? item.id : item.name
      resolved.push(id)
      return { ...credential, methodID: id === "quota" ? "chatgpt-browser" : "chatgpt-token-sharing" }
    },
  }
  const chosen = await codexHost(connections, "quota").active()
  expect(chosen?.label).toBe("Quota")
  await chosen?.resolve()
  expect(resolved).toEqual(["quota"])
  const active = await connections.active()
  expect(active?.type === "credential" && active.label).toBe("Inference")
  expect(await codexHost(connections, "missing").active()).toBeUndefined()
  const listed = await listQuotaConnections(connections)
  expect(listed.find((item) => item.id === "quota")?.codexNative).toBe(true)
  expect(JSON.stringify(listed)).not.toContain("fake-secret")
})

describe("Codex credential/network boundary", () => {
  test("token-sharing is tested at the endpoint, not rejected solely by method ID", async () => {
    let calls = 0
    const windows = await fetchCodexUsage(
      { ...credential, methodID: "chatgpt-token-sharing" },
      new AbortController().signal,
      request(() => {
        calls++
        return json(payload)
      }),
      now,
    )
    expect(calls).toBe(1)
    expect(windows[0]?.usedPercent).toBe(23.5)
  })
  test("rejected token-sharing quota access does not claim inference sign-in expired", async () => {
    await expect(
      fetchCodexUsage(
        { ...credential, methodID: "chatgpt-token-sharing" },
        new AbortController().signal,
        request(() => new Response("secret", { status: 403 })),
        now,
      ),
    ).rejects.toMatchObject({ status: "unsupported", message: expect.stringContaining("HTTP 403") })
  })
  test("uses only access token and intended account header", async () => {
    let count = 0
    const result = await fetchCodexUsage(
      credential,
      new AbortController().signal,
      request((url, init) => {
        count++
        expect(url).toBe("https://chatgpt.com/backend-api/wham/usage")
        expect(init?.redirect).toBe("error")
        expect(JSON.stringify(init?.headers)).not.toContain("never-send")
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer fake-secret",
          "ChatGPT-Account-Id": "test-account",
        })
        return json(payload)
      }),
      now,
    )
    expect(result).toHaveLength(1)
    expect(count).toBe(1)
  })
  test("API keys and expired credentials never hit the network", async () => {
    let calls = 0
    const fetcher = request(() => {
      calls++
      return json(payload)
    })
    for (const auth of [
      { type: "key", key: "secret" },
      { ...credential, expires: now - 1 },
    ]) {
      await expect(fetchCodexUsage(auth, new AbortController().signal, fetcher, now)).rejects.toThrow()
    }
    expect(calls).toBe(0)
  })
  test("sanitizes provider bodies and errors", async () => {
    for (const code of [401, 403, 429, 500]) {
      try {
        await fetchCodexUsage(
          credential,
          new AbortController().signal,
          request(() => new Response("SECRET RAW BODY", { status: code })),
          now,
        )
        throw new Error("Expected rejection")
      } catch (error) {
        expect(String(error)).not.toContain("SECRET RAW BODY")
      }
    }
  })
  test("parses Retry-After seconds and HTTP dates", () => {
    expect(retryAfter("90", now)).toBe(now + 90_000)
    expect(retryAfter(new Date(now + 60_000).toUTCString(), now)).toBe(now + 60_000)
    expect(retryAfter("bad", now)).toBeNull()
  })
})

describe("account-scoped collector", () => {
  test("unload during connection lookup cannot resurrect the collector", async () => {
    let release!: (value: ReturnType<typeof connection>) => void
    let calls = 0
    const collector = new CodexCollector(
      {
        active: () =>
          new Promise((resolve) => {
            release = resolve
          }),
      },
      request(() => {
        calls++
        return json(payload)
      }),
      () => now,
    )
    const reading = collector.read()
    collector.dispose()
    release(connection())
    expect((await reading).status).toBe("unavailable")
    expect(calls).toBe(0)
  })
  test("service Retry-After is honored for 503 too", async () => {
    let time = now
    let calls = 0
    const collector = new CodexCollector(
      { active: async () => connection() },
      request(() => {
        calls++
        return new Response("secret", { status: 503, headers: { "Retry-After": "600" } })
      }),
      () => time,
    )
    expect((await collector.read()).retryAt).toBe(now + 600_000)
    time += 120_000
    await collector.read(true)
    expect(calls).toBe(1)
    collector.dispose()
  })
  test("coalesces concurrent calls and throttles manual refresh", async () => {
    let calls = 0
    let time = now
    const collector = new CodexCollector(
      { active: async () => connection() },
      request(async () => {
        calls++
        await Promise.resolve()
        return json(payload)
      }),
      () => time,
    )
    const results = await Promise.all([collector.read(), collector.read(), collector.read(true)])
    expect(calls).toBe(1)
    expect(results[0]?.status).toBe("ready")
    expect(JSON.stringify(results)).not.toContain("fake-secret")
    await collector.read(true)
    expect(calls).toBe(1)
    time += 16_000
    await collector.read(true)
    expect(calls).toBe(2)
    collector.dispose()
  })
  test("new account and sign-out cannot reuse old quota", async () => {
    let active: Awaited<ReturnType<CodexHost["active"]>> = connection()
    let calls = 0
    const collector = new CodexCollector(
      { active: async () => active },
      request(() => {
        calls++
        return json(payload)
      }),
      () => now,
    )
    await collector.read()
    active = connection("b", { type: "key" })
    const next = await collector.read()
    expect(next.accountLabel).toBe("b")
    expect(next.windows).toEqual([])
    expect(next.status).toBe("unsupported")
    expect(calls).toBe(1)
    active = undefined
    expect((await collector.read()).status).toBe("signed-out")
    collector.dispose()
  })
  test("retains stale same-account data and respects Retry-After even on force", async () => {
    let time = now
    let calls = 0
    const collector = new CodexCollector(
      { active: async () => connection() },
      request(() =>
        ++calls === 1 ? json(payload) : new Response("secret", { status: 429, headers: { "Retry-After": "600" } }),
      ),
      () => time,
    )
    await collector.read()
    time += 121_000
    const stale = await collector.read()
    expect(stale.status).toBe("rate-limited")
    expect(stale.windows).toHaveLength(1)
    expect(stale.fetchedAt).toBe(now)
    time += 60_000
    await collector.read(true)
    expect(calls).toBe(2)
    expect(isStale(stale, time)).toBe(true)
    collector.dispose()
  })
  test("does not publish the previous account's in-flight result", async () => {
    let active = connection("a")
    let release!: (response: Response) => void
    const collector = new CodexCollector(
      { active: async () => active },
      request(() =>
        active.key === "a"
          ? new Promise<Response>((resolve) => {
              release = resolve
            })
          : json({ rate_limit: null }),
      ),
      () => now,
    )
    const first = collector.read()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    active = connection("b")
    const second = await collector.read()
    release(json(payload))
    const old = await first
    expect(old.windows).toEqual([])
    expect(second.accountLabel).toBe("b")
    expect((await collector.read()).windows).toEqual([])
    collector.dispose()
  })
})

describe("Claude sanitized status-line bridge", () => {
  test("retains only allowlisted numeric quota fields", () => {
    const result = sanitizeStatusline(
      {
        transcript_path: "secret",
        session_id: "private",
        rate_limits: {
          five_hour: { used_percentage: 0, resets_at: now / 1000, token: "secret" },
          spend_limit: { used_percentage: 90 },
        },
      },
      now,
    )
    expect(JSON.stringify(result)).not.toMatch(/secret|private|spend_limit/)
    expect(result.rate_limits.five_hour?.used_percentage).toBe(0)
    expect(sanitizeStatusline({}, now).rate_limits).toEqual({})
  })
  test("writes atomically, preserves observation age and reads sanitized cache", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".cache-test-"))
    try {
      const path = join(dir, "feed.json")
      const input = {
        rate_limits: { seven_day: { used_percentage: 40, resets_at: now / 1000 + 100 } },
        transcript_path: "secret",
      }
      await writeStatusline(input, path, now)
      await writeStatusline(input, path, now + 120_000)
      const cached = JSON.parse(await readFile(path, "utf8"))
      expect(cached.capturedAt).toBe(now)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      const snapshot = await readClaudeFeed(path, now + 600_000)
      expect(snapshot.windows[0]?.resetsAt).toBe(now + 100_000)
      expect(snapshot.accountLabel).toContain("unverified")
      expect(isStale(snapshot, now + 600_000)).toBe(true)
      await writeFile(path, "invalid SECRET")
      expect((await readClaudeFeed(path)).status).toBe("unavailable")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("passive Claude quota observation", () => {
  test("retains over-limit utilization rather than hiding the exhausted window", () => {
    const windows = parseClaudeHeaders(new Headers({ "anthropic-ratelimit-unified-5h-utilization": "1.02" }))
    expect(windows[0]?.usedPercent).toBe(102)
  })
  test("default server snapshot includes both providers and hooks preserve response streams", async () => {
    type Event = { model: { providerID: string }; request: Request; response: Response }
    const hooks = new Map<string, (event: Event) => unknown>()
    let snapshot!: (input: { refresh?: boolean }) => Promise<Snapshot>
    let resolved = 0
    const cleanup = await plugin.setup({
      options: {},
      storage: { get: async () => undefined, set: async () => {} },
      integration: {
        connection: {
          active: async (id: string) =>
            id === "anthropic" ? { type: "credential", id: "test-hook-account", label: "Test Claude" } : undefined,
          resolve: async () => {
            resolved++
            throw new Error("Should not resolve credentials")
          },
        },
      },
      session: {
        hook: async (name: string, callback: (event: Event) => unknown) => {
          hooks.set(name, callback)
          return {
            dispose: async () => {
              hooks.delete(name)
            },
          }
        },
      },
      rpc: {
        register: async (_contract: unknown, handlers: { snapshot: typeof snapshot }) => {
          snapshot = handlers.snapshot
          return { dispose: async () => {} }
        },
      },
    } as unknown as Parameters<typeof plugin.setup>[0])
    expect((await snapshot({})).providers.map((provider) => provider.provider)).toEqual(["codex", "claude"])
    const event: Event = {
      model: { providerID: "anthropic" },
      request: new Request("https://api.anthropic.com/v1/messages"),
      response: new Response("private body", { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.42" } }),
    }
    const response = event.response
    await hooks.get("http.request")!(event)
    await hooks.get("http.response")!(event)
    const observed = (await snapshot({})).providers.find((provider) => provider.provider === "claude")
    expect(observed?.windows[0]?.usedPercent).toBe(42)
    expect(observed?.accountLabel).toBe("Test Claude")
    expect(event.response).toBe(response)
    expect(response.bodyUsed).toBe(false)
    expect(resolved).toBe(0)
    if (typeof cleanup === "function") await cleanup()
    expect(hooks.size).toBe(0)
  })
  test("normalizes only subscription utilization/reset headers", () => {
    const windows = parseClaudeHeaders(
      new Headers({
        "anthropic-ratelimit-unified-5h-utilization": "0.42",
        "anthropic-ratelimit-unified-5h-reset": String(now / 1000 + 100),
        "anthropic-ratelimit-unified-7d-utilization": "0",
        authorization: "secret",
        "anthropic-ratelimit-requests-remaining": "500",
      }),
    )
    expect(windows).toHaveLength(2)
    expect(windows[0]).toMatchObject({ usedPercent: 42, resetsAt: now + 100_000 })
    expect(windows[1]).toMatchObject({ usedPercent: 0, resetsAt: null })
    expect(JSON.stringify(windows)).not.toContain("secret")
  })
  test("API rate limits and malformed headers cannot become subscription quota", () => {
    expect(parseClaudeHeaders(new Headers({ "anthropic-ratelimit-requests-remaining": "500" }))).toEqual([])
    for (const value of ["", "bad", "-0.1", "Infinity"]) {
      expect(parseClaudeHeaders(new Headers({ "anthropic-ratelimit-unified-5h-utilization": value }))).toEqual([])
    }
  })
  test("keeps observed accounts separate and shows Claude while waiting", () => {
    const observer = new ClaudeObserver()
    expect(observer.read("a").message).toContain("Waiting")
    expect(observer.read().status).toBe("signed-out")
    observer.observe("a", "Account A", new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.5" }), now)
    expect(observer.read("a").windows[0]?.usedPercent).toBe(50)
    expect(observer.read("b").windows).toEqual([])
    expect(observer.read("a").fetchedAt).toBe(now)
  })
})

test("countdown expiry never claims refreshed allowance", () => {
  expect(resetLabel(null, now)).toBe("Reset time unavailable")
  expect(resetLabel(now - 1, now)).toBe("Reset pending verification")
  expect(resetLabel(now + 61_000, now)).toBe("Resets in 2m")
  expect(resetLabel(now + 90 * 60_000, now)).toBe("Resets in 1h 30m")
})

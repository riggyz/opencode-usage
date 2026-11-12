import { expect, test } from "bun:test"
import { parseCreditGroups, fetchCodexUsage } from "../src/providers/codex"
import { creditExpiryLabel, resetSummaryLabel, Snapshot } from "../src/model"

test("reset inventory groups by reported type and drops redemption handles and prose", () => {
  const groups = parseCreditGroups({
    credits: [
      {
        id: "secret",
        reset_type: "weekly",
        status: "available",
        expires_at: "2030-01-01T00:00:00Z",
        title: "private title",
      },
      { reset_type: "weekly", status: "available", expires_at: null },
      { reset_type: "five_hour", status: "available", expires_at: "invalid" },
      { reset_type: "weekly", status: "redeemed", expires_at: null },
    ],
  })
  expect(groups).toEqual([
    { type: "five_hour", available: 1, expirations: [null] },
    { type: "weekly", available: 2, expirations: [Date.parse("2030-01-01T00:00:00Z"), null] },
  ])
  expect(JSON.stringify(groups)).not.toContain("secret")
  expect(JSON.stringify(groups)).not.toContain("private title")
  expect(parseCreditGroups({ credits: "bad" })).toBeUndefined()
})

test("matching summary includes safe groups; mismatched inventory falls back to summary", async () => {
  for (const available of [1, 2]) {
    const result = await fetchCodexUsage(
      { type: "oauth", methodID: "chatgpt-browser", access: "fixture", expires: 10000 },
      new AbortController().signal,
      (async (url: string) =>
        Response.json(
          url.endsWith("/usage")
            ? { rate_limit_reset_credits: { available_count: available } }
            : { credits: [{ reset_type: "weekly", status: "available" }] },
        )) as typeof fetch,
      0,
    )
    expect(result.resetCredits?.available).toBe(available)
    expect(result.resetCredits?.groups).toEqual(
      available === 1 ? [{ type: "weekly", available: 1, expirations: [null] }] : undefined,
    )
  }
})

test("expiration labels never imply renewed allowance", () => {
  expect(creditExpiryLabel(null, 0)).toBe("Expiration unavailable")
  expect(creditExpiryLabel(60000, 0)).toBe("Expires in 1m")
  expect(creditExpiryLabel(0, 1)).toBe("Expiration pending refresh")
  expect(Snapshot.safeParse({ providers: [] }).success).toBe(true)
})
test("one provider chip totals all reset types and uses the soonest group expiry", () => {
  expect(
    resetSummaryLabel(
      {
        available: 3,
        expiresAt: 120000,
        groups: [
          { type: "full", available: 1, expirations: [60000] },
          { type: "scoped", available: 2, expirations: [180000, 180000] },
        ],
      },
      0,
    ),
  ).toBe("3 resets · 1m")
  expect(resetSummaryLabel({ available: 2, expiresAt: 120000 }, 0)).toBe("2 resets · 2m")
  expect(resetSummaryLabel({ available: 0, expiresAt: null }, 0)).toBeUndefined()
  expect(resetSummaryLabel(undefined, 0)).toBeUndefined()
})

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"
import { randomUUID } from "node:crypto"
import { ClaudeFeed, claudeWindows, sanitizeStatusline } from "../src/providers/claude"

export async function writeStatusline(input: unknown, path: string, now = Date.now()) {
  if (!isAbsolute(path)) throw new Error("An absolute feed path is required")
  const feed = sanitizeStatusline(input, now)
  const previous = await readFile(path, "utf8")
    .then((text) => ClaudeFeed.safeParse(JSON.parse(text)))
    .catch(() => undefined)
  // Claude Code may rerun with cached quota; don't pretend identical data is a new observation.
  if (previous?.success && JSON.stringify(previous.data.rate_limits) === JSON.stringify(feed.rate_limits)) {
    feed.capturedAt = Math.min(previous.data.capturedAt, now)
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(feed), { mode: 0o600, flag: "wx" })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
  return claudeWindows(feed)
    .map((window) => `${window.label}: ${Math.round(window.usedPercent)}% used`)
    .join(" · ")
}

if (import.meta.main) {
  try {
    const path = process.argv[2]
    if (!path) throw new Error("Missing path")
    const input = await Bun.stdin.text()
    if (input.length > 1_048_576) throw new Error("Input too large")
    console.log(await writeStatusline(JSON.parse(input), path))
  } catch {
    // Neither status-line JSON nor file/network errors may leak to terminal output.
    console.log("Claude usage unavailable")
    process.exitCode = 1
  }
}

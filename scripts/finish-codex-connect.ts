// Completes a standard OpenCode-owned OAuth attempt; never handles OAuth tokens itself.
// Usage: bun scripts/finish-codex-connect.ts ATTEMPT_ID ORIGINAL_CREDENTIAL_ID UNIQUE_LABEL
import { z } from "zod"
const [attemptID, originalID, label] = z
  .tuple([z.string().min(1), z.string().min(1), z.string().min(1)])
  .parse(process.argv.slice(2))
const query = new URLSearchParams({ "location[directory]": process.cwd() }).toString()

async function api(method: string, path: string, data?: unknown): Promise<unknown> {
  const args = ["opencode", "api", method, `${path}?${query}`]
  if (data !== undefined) args.push("--data", JSON.stringify(data))
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const [stdout, , code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error("OpenCode connection operation failed")
  return stdout.trim() ? JSON.parse(stdout) : undefined
}

const Connection = z.object({ type: z.string(), id: z.string().optional(), label: z.string().optional() })
const Integration = z.object({ data: z.object({ connections: z.array(Connection) }) })
const Status = z.object({ data: z.object({ status: z.string() }) })

async function restoreInference() {
  const integration = Integration.parse(await api("get", "/api/integration/openai"))
  const current = integration.data.connections[0]
  if (current?.type === "credential" && current.label === label && current.id !== originalID)
    await api("post", `/api/credential/${encodeURIComponent(originalID)}/activate`)
}

try {
  const deadline = Date.now() + 10 * 60_000
  let complete = false
  while (Date.now() < deadline) {
    const status = Status.parse(
      await api("get", `/api/integration/openai/connect/oauth/${encodeURIComponent(attemptID)}`),
    )
    if (status.data.status === "complete") {
      complete = true
      break
    }
    if (status.data.status !== "pending") throw new Error("Codex authorization did not complete")
    await Bun.sleep(1000)
  }
  if (!complete) throw new Error("Codex authorization expired")
  const integration = Integration.parse(await api("get", "/api/integration/openai"))
  const saved = integration.data.connections.find((item) => item.type === "credential" && item.label === label)
  if (!saved?.id) throw new Error("New Codex connection not found")
  // Native OpenCode sign-in selects a newly created connection. Restore only if it is still selected;
  // don't overwrite a different intentional selection the user made during the sign-in.
  if (integration.data.connections[0]?.id === saved.id) {
    await api("post", `/api/credential/${encodeURIComponent(originalID)}/activate`)
  }
  const selection = z
    .object({ output: z.object({ selected: z.boolean() }) })
    .parse(await api("post", "/api/rpc/riggyz.usage/selectCodexConnection", { input: { id: saved.id } }))
  if (!selection.output.selected) throw new Error("Quota connection could not be selected")
  const snapshot = await api("post", "/api/rpc/riggyz.usage/snapshot", { input: { refresh: true } })
  // Only print the plugin's already-sanitized quota response, never native OAuth responses.
  console.log(JSON.stringify(snapshot))
} catch {
  await api("delete", `/api/integration/openai/connect/oauth/${encodeURIComponent(attemptID)}`).catch(() => undefined)
  console.error(
    "Codex quota connection did not complete. No tokens were printed. Check the OpenAI inference selection before retrying.",
  )
  process.exitCode = 1
} finally {
  await restoreInference().catch(() => {
    console.error("Could not verify the restored inference selection. Check OpenAI accounts in OpenCode.")
    process.exitCode = 1
  })
}

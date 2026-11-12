# OpenCode Usage

A small account-usage indicator for **OpenCode V2 desktop**, targeting its experimental GUI API in **2.2.4**.

## Install from GitHub

```sh
opencode plugin add github:riggyz/opencode-usage
```

The repository includes the prebuilt desktop bundle: no clone or install-time build is needed. Pin a published release with `github:riggyz/opencode-usage#<release-tag>`. The original `v0.1.0` tag predates the Git-install fix; use the unpinned command above until a fixed release is published.

The development build command is named `build:gui` deliberately: npm treats a script named `build` as a Git dependency preparation trigger, even when install scripts are disabled. Keeping the committed bundle and avoiding preparation hooks lets OpenCode install directly from GitHub.

```sh
opencode plugin check
opencode plugin update github:riggyz/opencode-usage
opencode plugin remove github:riggyz/opencode-usage
```

Sign in/select the quota accounts separately as described below; installing the plugin never signs into your accounts automatically. `private: true` in the package manifest prevents npm publishing, not GitHub installation.

## UI

- A subtle monochrome split ring, left of the native session-context toggle.
- Claude occupies the top half; Codex the bottom. Each half can show a 5-hour outer track and a 7-day inner track. Only reported windows are drawn.
- If Codex reports a weekly limit but no 5-hour limit, its weekly arc fills the combined thickness of both tracks.
- Hover or focus the ring for provider, window, percentage used and reset countdown details. Click to refresh. An amber warning marker identifies stale/offline observations without a permanent text label.
- Available reset credits appear as one small muted chip per provider on the right inside the ring's native tooltip. Each chip shows the total count and nearest expiration countdown inline: `3 resets · 18d 6h`. Hover or focus for the type/scope breakdown and individual expiration countdowns; if only a summary is available, it shows the earliest reported expiration. Usage countdowns are plain right-aligned text without unit subcolumns. No email addresses, connection IDs or account names appear in the details.
- Data is global across chats/projects, with one poller per desktop window. Last observations persist across plugin reloads; restoring data never makes it appear newly fetched.
- Unknown is not 0%. Stale/offline state is marked without flashing or changing provider colors.

## Develop

Requires Bun **1.3.14+** and OpenCode V2 **2.2.4**.

```sh
bun install --frozen-lockfile
bun run check
bun run build:gui
```

`bun run dev` watches the GUI bundle. **Commit `dist/gui-experimental.cjs` with source changes**, as in `opencode-pets`, so GitHub installations work without build hooks. CI rejects a stale bundle and checks formatting, types, mocked tests and high/critical dependency advisories. See `SECURITY.md` for known moderate SDK findings.

## Releases

1. On `main`, run the **Release** workflow and choose `patch`, `minor` or `major`.
2. It validates the project, bumps the version, rebuilds the committed bundle and opens a `chore(release): vX.Y.Z` pull request.
3. **Squash-merge using that exact release title** (or rebase-merge the release commit). **Publish release** revalidates the merged commit, tags it and creates the GitHub Release with installation instructions.

The initial `v0.1.0` uses the same release-commit convention. Publish can be rerun on that commit with **Run workflow** after a transient failure; existing releases are skipped and existing tags never move. GitHub Actions must be allowed to create pull requests in the repository's Actions workflow-permission settings. `npm version patch --no-git-tag-version` also runs the local validation/build hooks when preparing a release manually.

## Load

Build first. Add the checkout directory to global `~/.config/opencode/opencode.json(c)`, preserving other plugins/settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-usage",
      "options": { "codex": true, "claude": true },
    },
  ],
}
```

OpenCode watches config; local GUI rebuilds reload automatically. Use `/reload` if needed, not a background-service restart. The widget shows the desktop's own global monitoring accounts, not the selected remote session's accounts.

## How usage is obtained

**Codex:** OpenCode resolves a saved native Codex OAuth connection, and the server reads `https://chatgpt.com/backend-api/wham/usage`. This endpoint is private and can change. The newer ChatGPT token-sharing inference login returned HTTP 401 from that endpoint, so monitoring uses a separate standard Codex login. When the usage response reports `rate_limit_reset_credits.available_count` above zero, the server also reads `/wham/rate-limit-reset-credits` and keeps available counts by `reset_type` and their expiration times, plus the earliest expiry. If detail counts disagree with the summary, only the summary is shown. Credit IDs, titles, descriptions and referral profile fields are discarded. No separate Codex CLI or token lifecycle is implemented here.

**Claude:** ordinary OpenCode Claude responses supply allowlisted subscription usage/reset headers. Observation is passive: no extra Anthropic requests, prompts, response-body reads or credential access. It updates when Claude is used and cannot guarantee freshness after usage elsewhere.

**Optional Claude reset inventory:** `options.claudeResetInventory: true` enables a separate read-only `GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1` through the host-resolved active Anthropic OAuth connection. This is a private, community-observed endpoint, not a supported public contract or evidence of vendor permission. It uses the CLI-shaped compatibility User-Agent `claude-cli/2.1.280 (external, cli)` reported in CodexBar issue #3895; no local Claude Code installation is needed or launched. Rejection never triggers cookie access or a different credential. Reads are demand-driven, coalesced and limited to once per five minutes, respecting longer `Retry-After` delays. Only eligible, started, unpaused and unexpired grants contribute; saved resets count even if redemption is currently gated. Counts, cleared-window scopes, expiry times and optional usability are retained; grant IDs and labels are discarded. Inventory failures never replace passive usage or make old data fresh. Auth rejection discards inventory. This inventory is not persisted or merged into an account-unverified status-line feed, and no reset is ever redeemed.

Both providers have been verified live. Sanitized account-keyed observations are stored in OpenCode's global plugin KV, outside the repo. No tokens, device codes or raw provider responses belong in Git.

## Separate Codex connection

The built-in OpenCode device-code method is `chatgpt-headless`. To prepare a separate monitoring login:

1. Record the current OpenAI inference credential ID from `opencode api get /api/integration/openai` (active connection is first in the target version).
2. Start the standard flow with a unique label:

   ```sh
   opencode api post /api/integration/openai/connect/oauth --data '{"methodID":"chatgpt-headless","label":"Codex quota"}'
   ```

3. Start the completion helper with the returned attempt ID, original credential ID and matching label, then approve the provided device code in your browser:

   ```sh
   bun scripts/finish-codex-connect.ts ATTEMPT_ID ORIGINAL_CREDENTIAL_ID 'Codex quota'
   ```

Native OpenCode sign-in briefly selects its new credential. The helper restores the prior inference selection only if the newly created quota connection is still selected, then stores the independent monitor selection and tests quota. Do not reload during authorization. If the helper fails, check the inference selection before continuing.

Alternatively, `options.codexConnectionID` pins an existing native Codex credential for monitoring without activating it. IDs are host-local references, not tokens; keep machine-specific config outside the repo. Make sure the chosen monitoring account is the one whose quota you want.

## Optional Claude fallback

If passive headers are unavailable, `scripts/claude-statusline.ts` can accept official Claude Code status-line JSON on stdin and atomically cache only numeric quota fields and capture time:

```sh
bun /absolute/path/to/opencode-usage/scripts/claude-statusline.ts /absolute/path/to/claude-usage.json
```

Set `options.claudeStatuslineFile` to the same absolute cache path. Compose with any existing Claude Code status-line command rather than replacing it blindly. This fallback depends on Claude Code activity and cannot verify its account against OpenCode. No global Claude configuration is changed automatically.

## Limits and references

The rings represent the reported 5-hour/7-day account windows, not session tokens or an aggregate balance. Other reported windows remain in the tooltip. Missing windows are not invented; reset expiry never zeroes usage without a fresh observation. Reset credits are display-only: the plugin never redeems one, and their expiry does not change any window. Spending credits are out of scope.

- https://opencode.ai/v2/docs/build/plugins/gui
- https://opencode.ai/v2/docs/build/plugins/server#integrations
- https://opencode.ai/v2/docs/build/plugins/rpc
- https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs
- https://code.claude.com/docs/en/statusline#rate-limit-usage
- https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use

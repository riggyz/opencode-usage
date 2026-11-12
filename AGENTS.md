# OpenCode Usage

Personal OpenCode **V2 desktop** plugin. Read README.md before changing provider/auth behavior.

- Use only https://opencode.ai/v2/docs/ for OpenCode contracts. GUI API is experimental; target SDK 2.2.4.
- Keep credentials in the server and use the host integration resolver. Never read auth files/Keychain, refresh tokens independently, or send secrets/raw provider errors over RPC or logs.
- Quota percentages are account-wide, not session token counts. Missing data is not zero. Reset expiry must never manufacture new allowance.
- UI state/polling belongs to window setup, never a per-chat component. Preserve account-keyed snapshots globally without refreshing their timestamps on restore. Toolbar is a monochrome split ring: Claude top, Codex bottom; outer track 5h, inner track 7d. Missing windows stay absent. Slot order 0 is before native context. Tooltip contains only provider/window/percent/reset countdown, the Codex reset-credit count with earliest-expiry countdown (when reported and nonzero), and necessary stale/offline status—no account identifiers, absolute dates, legend or instructions. Never redeem reset credits. No pill chrome or active-provider coloring.
- Claude usage observation stays passive: only allowlisted quota headers from existing OpenCode Claude responses; the optional status-line bridge remains available. Never read an inference response body for quota observation. Separately, explicit `claudeResetInventory` opt-in permits demand-driven read-only inventory requests through the host resolver, with a five-minute cooldown and Retry-After handling. Never redeem grants, persist redemption handles, or let inventory reads refresh passive usage timestamps.
- A Codex weekly-only plan uses a wide weekly arc spanning both track bounds. Keep two thin tracks when a 5-hour window is reported; do not widen Claude or draw an invented Codex 5-hour window.
- Keep providers small and testable. No custom framework, generated copies of upstream SDKs, or DOM injection.
- `bun install`, `bun run check`, `bun run build:gui`. Commit the prebuilt `dist/gui-experimental.cjs` with source changes for GitHub installs; CI verifies it matches a rebuild. Do not commit or publish unless asked.
- Do not change global OpenCode or Claude Code config without making the intended change explicit to Ethan.

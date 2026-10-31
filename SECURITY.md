# Security

The source and versioned releases are distributed on GitHub. `private: true` prevents accidental npm publishing; it does not make the GitHub repository private. No public license has been selected (`UNLICENSED`); do not add a license or publish to npm without the owner's approval.

## Boundaries

- OpenCode owns credentials, sign-in and refresh. The plugin never reads auth files/Keychain or exports tokens.
- Only allowlisted quota fields and account references/labels are cached in OpenCode's global plugin storage. That data is outside this repository.
- Claude observation reads known response headers only: no prompts, request authorization headers or response bodies.
- Codex uses a private usage endpoint. Compatibility can change; this is not a supported public REST contract.
- Tests use mocked credentials and responses; CI needs no provider credentials or authenticated quota calls.
- Never attach raw logs, credential stores, provider response bodies, emails or device codes to an issue. Redact account details from screenshots.

Report problems privately to the repository owner. Do not include live secrets in a report.

## Dependency advisories

Checked October 30, 2026. The pinned `@opencode/plugin@2.2.4` dependency inherits two moderate findings:

| Dependency  | Advisory                                                                                      | Reason retained                                        |
| ----------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `minimatch` | https://github.com/advisories/GHSA-g3hv-75wg-m249 — globparts amplification denial of service | Patched major 11 is outside the SDK's major-10 ranges. |
| `glob`      | https://github.com/advisories/GHSA-3g3m-2fjr-6pw4 — cancellation bypass during traversal      | Patched major 14 is outside the SDK's pinned major 13. |

The plugin does not call those filesystem/glob APIs itself. That is not a claim that the SDK is unaffected. Avoid untested major overrides; recheck when adopting a compatible SDK update. `bun audit` reports all findings; CI gates high/critical findings without suppressing these advisories.

# FargoWork Windows employee trial

This complete package connects an AI client to your administrator's FargoWork service. It contains a standard Skill, the native CLI/stdio bridge, and a checksum-checked installer. Install only a package whose SHA-256 matches the release checksum.

## Ask your AI to install

Give the complete Windows x64 ZIP to an AI that can read files and run local commands. Ask it to verify and extract the package, select its own installation target, run the installer, guide your DingTalk authorization, and verify `get_current_user` through its FargoWork MCP connection.

For example, Cursor runs this from the extracted package directory:

```powershell
./install.ps1 -Target cursor -ServiceIssuer 'https://fargowork.fargowealthapp.com' -LocalArtifactDir . -Login -OpenBrowser always -OutputJsonl
```

Other targets are `codex`, `workbuddy`, and `claude-code`. Use a comma-separated list for multiple clients, such as `-Target 'cursor,codex'`. With `manual`, the installer emits the absolute executable plus `bridge` arguments and a Skill path; the AI must configure its own client according to official documentation. No access token belongs in MCP configuration. Current Bridge client protocol is `2025-11-25`; the cloud protocol is `2026-07-28`.

Use the official entry once. A known embedded Codex executable can be supplied with `-CodexPath` as a verified absolute path; do not guess paths or treat an embedded framework as a verified MCP connection. If company policy blocks execution, stop and report the safe error; do not change policy or elevate privileges. DryRun downloads/verifies temporary artifacts and writes diagnostics, but does not install employee/client configuration.

The listed issuer is the company cloud test service. All workflows are test-only; new submissions require the company's `MCP_allow` role and the exact draft confirmation. macOS is deferred. OAuth returns to `http://127.0.0.1:37680/oauth/callback`. Complete authorization yourself. Client trust/enable and a new session may be required. Installation, login, and actual MCP connection are separate results; check each.

## Login and support

Login can also be run separately:

```powershell
& "$env:APPDATA\FargoWork\employee\bin\fargowork.exe" login
& "$env:APPDATA\FargoWork\employee\bin\fargowork.exe" status --target cursor
```

The refresh credential is stored in Windows DPAPI under the employee profile and bound to the configured service. Never share tokens, OAuth codes, cookies, or credential files.

The current Server Manifest defines workflows and requirements. Review the complete preview and explicitly confirm the exact draft before any authorized submission. Current preview confirmation is a Skill/chat responsibility, not an independent server-verified human confirmation credential. For an error or unknown submission result, stop and provide the safe message and support code to the designated support channel; do not retry an uncertain submission.

Employees can edit ordinary draft values and legal business choices. Fixed workflow rules, permissions, approval routing, and the governed Server belong to designated owners. Keep personal preferences in separate user-owned files; managed official Skill content is refreshed during updates.

## Update

Use the next published package, verify its checksum, and run its installer. The installer keeps credentials and account-scoped preference documents. After verified identity, the CLI selects the current enterprise/user's own document. On an actual version upgrade, the Agent asks once whether to reset it; keeping is the default and an unanswered question does not block installation. Reset affects only the current account's preferences, never credentials, drafts or other accounts. Start a new AI conversation after an account switch.

It only manages FargoWork-owned client files and registrations; foreign same-name configurations are preserved and reported as conflicts. Fargo AI/Fargo Pass is a separate product and must not be moved, deleted or used as a FargoWork credential source.

Local diagnostics live in `%APPDATA%\FargoWork\diagnostics`, with a seven-day retention and 20 MiB directory budget. Ask your Agent to use `fargowork.exe diagnostics export` for the relevant attempt/window. Export is voluntary, includes only approved event fields, and excludes credentials, personal profiles, chat and workflow bodies. It is not automatically uploaded. See DATA-AND-SUPPORT.md before entering sensitive business information.

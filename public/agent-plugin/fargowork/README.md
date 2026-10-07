# FargoWork Employee Agent Plugin

This portable Agent Plugins 1.0.0 package contains one standard employee Skill and a plugin-relative stdio MCP bridge. The plugin identity is `fargowork-employee`, separate from the maintainer's private development plugin.

The current employee trial delivers a Windows x64 executable. macOS is deferred. The core Skill and MCP contract are independent of the AI client; installation adapters configure known hosts, while third-party hosts use the emitted absolute executable and `bridge` arguments. Adapter tests are not a claim of actual employee acceptance in every client.

The matching executable is installed beside `bin/fargowork.cmd`. The CLI owns FargoWork OAuth Authorization Code + S256 PKCE and Windows DPAPI refresh-credential storage. The bridge keeps access tokens in memory and connects to the administrator-configured cloud MCP resource. Client trust and enable state remain user-controlled.

Agent Plugins v1 does not define portable OAuth configuration or credential references. Clients differ in plugin path expansion and installation; where native plugin loading is incomplete, use the installation adapter or a verified standard stdio registration. The client-facing Bridge negotiates `2025-11-25`; the cloud uses `2026-07-28`.

The Skill contains public conversation and safety contracts, not Yida field IDs, form identifiers, approval rules, credentials, or business data. The server enforces identity, ownership, permissions, fixed targets, validation, and submission policy. Human preview confirmation currently remains a Skill/chat responsibility.

Use a service issuer provided by the administrator. The official installer is a single entry for the complete Windows package; known native registration or the verified manual stdio/Skill contract remains a host responsibility.

Preferences live in independent documents scoped to the verified enterprise/user. Updates preserve them and prompt once to keep or reset the current account, defaulting to keep. They never grant Server permissions. Local diagnostics share `%APPDATA%\FargoWork\diagnostics`, retain up to seven days/20 MiB, and require voluntary allowlisted export. No credentials, profile bodies or workflow bodies are included. Fargo AI/Fargo Pass is a separate product and its files are outside this package's ownership.

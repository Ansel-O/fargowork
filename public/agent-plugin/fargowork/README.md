# FargoWork Agent Plugin

This is the FargoWork public Agent Plugin package. It targets Agent Plugins 1.0.0 and
contains one Agent Skill plus a plugin-relative stdio bridge declaration.

The installer places the matching platform `fargowork` executable beside
`bin/fargowork.cmd`. The executable is the single FargoWork CLI and bridge;
the plugin does not contain credentials, an endpoint secret, or workflow rules.

Agent Plugins v1 leaves OAuth, authorization discovery, user interaction, and
credential storage to the client. FargoWork's CLI owns the OAuth Authorization
Code + S256 PKCE handoff and stores only the rotated refresh token in the OS
secure credential store. The bridge keeps access tokens in memory and injects
them into the configured FargoWork MCP resource.

The installer uses the official CodeBuddy user-scope MCP CLI when it is
available, registering the installed launcher without copying credentials. On
WorkBuddy, use Settings -> Connectors -> Custom Connector (or Settings -> MCP)
to trust and enable the FargoWork entry; this UI trust state remains
user-controlled and the CLI reports it as `unknown` until enabled.

The server remains authoritative for workflow manifests, fields, permissions,
validation, preview, confirmation, submission, and audit. The Skill contains
only public conversation and safety contracts; it does not contain Yida field
IDs, form identifiers, internal rules, production configuration, or business
data.

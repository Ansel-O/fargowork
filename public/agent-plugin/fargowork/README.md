# FargoWork Employee Agent Plugin

The Windows x64 employee package contains the standard FargoWork Skill and
official CLI. The default workflow path is `fargowork tools list` and
`fargowork tools call NAME`; the CLI owns OAuth, protected credential storage
and access to the administrator-configured service.

Load the employee Skill and complete employee login. The employee can then
request a workflow without editing MCP JSON, installing a temporary Node
client or changing the host to FullAccess. An optional plugin-relative stdio
MCP bridge remains available for compatible clients; native MCP registration
is not a prerequisite for the CLI path.

The Server Manifest controls workflows, inputs and permissions. The Skill
shows a complete business preview and obtains one natural-language confirmation
for the exact draft. Do not ask again for an unchanged, unexpired, confirmed
draft. Stop on unsafe errors or unknown outcomes; never automatically resubmit.

Account preferences are separate, editable documents for the verified employee.
Updates preserve them and ask once about reset, defaulting to keep. Local
diagnostics are payload-free and voluntarily exported. Fargo AI/Fargo Pass is
a separate product whose credentials and configuration are outside this package.
macOS support is deferred; current company workflows are for testing.
# FargoWork Employee Agent Plugin

The Windows x64 employee package ships one official CLI and five Skills: the
`fargowork-employee` process router plus independent Business Trip, Annual
Leave, Procurement Request, and External Expense Request Skills. They install
together; employees do not install a separate process package.

The default workflow path uses `fargowork tools list` and
`fargowork tools call NAME`. The CLI owns OAuth, protected credential storage,
and access to the administrator-configured service. Load the employee router
or the matching process Skill and complete employee login before beginning a
workflow.

This package does not ship a stdio Bridge, host MCP registration, or launcher.
Employees do not need to edit MCP JSON, install an ad hoc runtime, or change the
host to FullAccess. The CLI retains its service-side MCP HTTP protocol.

The current Server contract controls workflows, inputs, candidates, validation,
and permissions. The matching Skill presents the complete semantic preview and
obtains one natural-language confirmation for the exact draft. An unchanged,
unexpired, already confirmed draft is submitted without asking again. Unsafe
errors and unknown outcomes stop; a business submission is never automatically
resubmitted.

Account preferences are separate editable documents for the verified employee.
Updates preserve them and ask once about reset, defaulting to keep. Local
diagnostics are payload-free and voluntarily exported. Fargo AI/Fargo Pass is a
separate product whose credentials and configuration are outside this package.
macOS support is deferred.

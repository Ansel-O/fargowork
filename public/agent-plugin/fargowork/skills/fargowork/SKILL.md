---
name: fargowork
description: FargoWork governed office workflow router for supported company processes. Use when a configured FargoWork MCP server is available and the user says FargoWork or asks in Chinese or English to discover, prepare, preview, refresh, or explicitly submit an office workflow such as 出差申请、差旅、年假申请、请年假, business trip, or annual leave.
---

# FargoWork workflow skill

This file is the public Agent Skill contract. It describes conversation safety
and the semantic MCP contract; the private Server Manifest remains authoritative
for the actual workflow set, inputs, candidates, validation, and submission.

## Package status

This package is a public client package. Its root `mcp.json` launches the
plugin-relative FargoWork stdio bridge after the installer has placed the
platform executable in `bin/`. The bridge talks to the configured FargoWork
MCP resource and performs no legacy session fallback.

When CodeBuddy is available, the installer registers the absolute bridge
launcher in the official user-scope MCP registry. WorkBuddy trust is still
deliberately user-controlled: the CLI reports `trusted=unknown` and
`needs_user_action=true` until the user trusts and enables FargoWork in the
WorkBuddy UI. Do not claim that CLI registration is the same as WorkBuddy
trust.

If a client has no separately configured FargoWork MCP connection, report that
the connection is not configured and stop. Do not invent an endpoint, add a
Bearer header, recover the old Local/client-session path, or ask the user to
copy a token.

## Identity and connection

1. Use only a configured FargoWork MCP connection. The M2 identity boundary is
   FargoWork OAuth Authorization Code + S256 PKCE bound to the DingTalk
   enterprise identity; it is not replaced by a client-supplied userid or corp.
2. When the connection is available, call the public current-user capability
   (for example `fargowork.get_current_user`) and confirm the returned identity
   before reading workflow data.
3. If authentication is missing, expired, revoked, or ambiguous, stop and tell
   the user to run `fargowork login`. Never request or display access tokens,
   refresh tokens, cookies, authorization headers, OAuth codes, or secrets.
4. Do not treat a local config file, client profile, or userid/corp claim as
   proof of Server identity.

## Workflow protocol

1. Discover the exact process through the public workflow-resolution capability
   (for example `fargowork.resolve_work_template`). If the request is vague,
   show the Server's semantic candidates and ask the user to choose; do not
   guess.
2. After selecting a process, load only its matching reference module under
   `references/` when one exists. The reference modules organize conversation;
   they do not replace the Server Manifest.
   For any date or time input, also load [Time Contract](references/time-contract.md)
   and follow its semantic-date rules without doing independent timezone math.
3. Read the public input and preview contracts. Collect only values declared as
   employee `user_input`. `system_managed` values cannot be supplied or changed
   by the user. `server_candidate` values may only be selected from the current
   Server response.
4. Prepare a draft through the public prepare capability. Handle structured
   `needs_input`, `needs_confirmation`, `blocked`, and `ready_for_preview`
   outcomes explicitly. A policy block is an answer, not an invitation to retry
   with altered system fields.
5. For `ready_for_preview`, present the semantic preview returned by the Server.
   Do not expose raw upstream responses, field IDs, form identifiers, internal
   source maps, permission facts, or submission payloads.
6. Call the submit capability only after the user has seen the final preview and
   clearly confirmed the exact action in natural language. Pass only the
   Server-issued `draft_id`; never construct a Yida payload in the client.
   Before a normal submit, do not narrate retry or idempotency policy. After the
   call, render `action_result.display_message` verbatim. Do not paraphrase it or
   append a generic retry warning.
7. If the user explicitly asks to refresh because authoritative data changed,
   repeat preparation with the original employee inputs. The old draft and
   confirmation are no longer submit-capable.
8. A draft remains submit-capable only on its `Asia/Singapore` creation date.
   After that date, prepare a new draft, show a new preview, and obtain a new
   confirmation.

## Safety rules

- The authenticated employee is the only applicant. Reject requests to act as
  another userid or to rewrite employee status, department membership, balance,
  approval identity, or other system-managed facts.
- Do not pass `form_data`, `form_uuid`, `process_code`, `process_data`, raw Yida
  Field IDs, arbitrary query controls, or undeclared fields.
- Do not call internal roster, contact, project, configuration, or raw Yida
  tools to bypass a governed workflow.
- Do not loop preparation, delete blocking values, guess candidates, or use an
  old draft to bypass policy, identity, expiry, or confirmation.
- Treat `ready_for_preview` as preview readiness, never as submit authorization.
- Never retry a submission on your own. Obey
  `action_result.automatic_retry_allowed`; the Server message explains the
  recovery boundary only when it is relevant.
- Do not claim support for a process that the current Server Manifest does not
  publish. Do not claim WorkBuddy is trusted until the user completes its UI
  action.
- Published reference modules are governed artifacts. Do not modify them during
  ordinary employee workflow use.
- Treat an ordinary employee workflow as transaction mode. Do not open a shell,
  inspect or edit source code, restart services, install dependencies, or
  delegate repair/testing tasks. If a public FargoWork tool returns a server or
  dependency error, show only its safe employee message and support code, then
  stop that transaction. Maintenance requires a separate explicit developer
  request outside the employee workflow.
- Use the configured FargoWork workflow tools for supported processes. Do not
  switch to DWS, OpenYida, DingTalk OA, or another similarly named Skill after
  FargoWork has resolved the process unless the user explicitly changes tools.

## Public reference modules

- [Business Trip](references/workflow-business-trip.md)
- [Annual Leave](references/workflow-annual-leave.md)
- [Time Contract](references/time-contract.md)

These modules intentionally contain no field IDs, form UUIDs, production
endpoints, credentials, private rules, or real employee data.

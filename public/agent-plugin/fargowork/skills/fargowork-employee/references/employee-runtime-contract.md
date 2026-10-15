# FargoWork employee runtime contract

Read this only when using an installed FargoWork workflow. It applies to the router and all process Skills.

## Official CLI and tool results

- Use the installed official CLI, normally `$env:APPDATA\FargoWork\employee\bin\fargowork.exe` on Windows. Use its verified installed path; do not guess a service endpoint.
- Discover available public tools with `fargowork tools list --output jsonl`. Call only a public tool returned by the current service with `fargowork tools call NAME --output jsonl`.
- Supply one UTF-8 JSON argument object on stdin or with `--input-file PATH`. Do not place employee text into shell code. If a temporary input file is needed, create a new one outside diagnostic folders and remove only that file after the call. Never keep business bodies in logs.
- Read the MCP result from `structuredContent`, or parse its JSON text content. If the SDK wraps it in a single `result` object, use that inner business result. Honor `isError` before interpreting the result; do not guess through mixed or malformed envelopes.
- A CLI status of `completed` means the tool call finished, not that a business application was submitted. Trust the business outcome. Show a safe employee message and support code for an error, then stop.

## Selected environment and endpoint

- Treat the environment and issuer selected in the installed client configuration as fixed for this request. Do not automatically switch among local, preproduction (`pre`), and production.
- If the selected endpoint is unavailable or refuses the connection, state which selected environment is unreachable and stop. Do not try another endpoint, run the production bootstrap, or change the issuer to bypass the failure.
- Switch environments or issuers only after the Owner explicitly authorizes the change. After an authorized switch, use only the newly selected environment and endpoint.

## Current Server contract

- For the resolved process, call `get_work_template_requirements` and follow its current public tools, recommended flow, input contract, constraints, preview contract, and review contract. The current Server response is authoritative; a Skill only supplies conversation guidance.
- Use `prepare_process_draft` for the current complete semantic input snapshot and `submit_process_draft` only for the exact Server-issued draft after final confirmation.
- Collect only fields declared with `user_input` authority. Never supply or overwrite `system_managed` values. Return `server_candidate` values only from the current response. Do not send raw form payloads, form identifiers, Field IDs, internal configuration, arbitrary query controls, or another person's identity.
- Keep the complete established semantic input snapshot across turns. On each preparation send all known declared inputs, changing only an explicit correction or a current legal candidate selection. Never send managed preview values back as employee inputs.
- Handle `needs_input`, `needs_selection`, `blocked` (including `blocked_by_policy`), and `ready_for_preview` according to the response. Treat `needs_confirmation` with `interaction=selection` only as a compatibility alias for candidate selection; it is never final submission authorization. Candidate selection is not authorization to submit. A policy block is a stop, not a reason to change protected facts.
- Use only adaptations explicitly declared in the current input contract. Do not split work to evade thresholds, approvals, budgets, or access rules. If a declared path creates separate drafts, keep each draft and result distinct; stop the remaining submissions after a failed or unknown result.

## Final preview and submission

- Follow the returned `review.confirmation_mode` and `review.confirmation_scope`. For the current `confirmation_mode=single_final` and `confirmation_scope=exact_draft`, show the complete semantic preview with material warnings and choices, then ask once whether the employee wants to submit that exact application.
- After an unchanged, unexpired draft has already been previewed and clearly confirmed, submit that same draft once without asking again. Call the current public submit tool with only the Server-issued draft ID.
- A material edit, refreshed authoritative data, new draft, or expiry invalidates the prior confirmation. Prepare the revised snapshot, show its complete preview, and obtain one confirmation for that exact draft.
- Draft validity is enforced by the Server and currently ends on the Asia/Singapore creation date. After expiry, prepare a new draft, show its preview, and obtain a new confirmation.
- Never automatically retry a submission. Do not resubmit a successful or unknown draft, or create another draft to retry an unknown result. Follow `action_result.automatic_retry_allowed`; when the outcome is unknown, stop and use only the published reconciliation path.
- Render `action_result.display_message` as returned. Do not append generic retry or implementation commentary. Keep internal calls quiet: show only necessary authorization guidance, concise input questions, the complete final preview, and the result.

## Client boundary

Use the [login contract](login-contract.md) for business identity and authorization. This employee package uses the official CLI and Skill; do not register a stdio Bridge or host MCP configuration, install an ad hoc runtime, write a temporary Node/Python MCP client, edit MCP JSON, or ask for FullAccess as a prerequisite. Fargo AI/Fargo Pass is a separate product.

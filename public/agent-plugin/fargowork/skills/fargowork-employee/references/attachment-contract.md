# FargoWork workflow attachments

Read this only when the current workflow requirements declare attachment support. Never assume that a process accepts files because another process does.

## Upload and selection

- Use only files the employee provided or explicitly selected. Do not search their device, fetch arbitrary URLs, install a parser, or pass file bodies or local paths to a business tool.
- Create one batch per application with `fargowork attachments create --process WORKFLOW_KEY`, replacing `WORKFLOW_KEY` with the exact workflow key resolved by the Server and supported by the installed CLI. Keep its batch ID while collecting missing inputs and preparing revised drafts. Upload each selected file once with `fargowork attachments upload --batch BATCH --file ABSOLUTE_PATH`. If an upload result is unknown, check that batch with `fargowork attachments status --batch BATCH` before doing anything else; do not upload a duplicate based on a guess.
- If attachment authorization is missing, use `fargowork attachments login --browser always` and the employee's own authorization. The CLI checks that the attachment identity is the same verified employee as the business session before login and before each operation. If it reports an identity mismatch or unclear authorization, stop; do not expose the identity values. The attachment service has a separate credential and authorization purpose.
- Replace the final selection with `fargowork attachments select --batch BATCH --ids ID...`, using only IDs from that batch. An empty ID list clears the selection; selection changes do not delete stored originals. Pass only attachment fields declared by the current workflow contract, using that batch ID and exact selected IDs. The Server resolves canonical file facts and validates the selection.
- Include the Server-returned filenames in the final semantic preview. If the selected files change after preview, prepare and preview the revised exact snapshot before asking for its single final confirmation.

## Submission binding

- The official CLI sends the attachment notice after it receives a confirmed successful business submission with the real process-instance ID. Do not invent, substitute, or manually type an instance ID.
- If the CLI reports that the business application was submitted but attachment binding is still pending, say that plainly. Never describe the business application as failed and never submit it again.
- Only use `fargowork attachments status --batch BATCH` and, for a confirmed business submission whose binding is still pending, `fargowork attachments notify --batch BATCH` for that same saved batch and notice. The CLI preserves the real submitted instance, final file snapshot, and idempotency key; notification attempts are limited to three total including the automatic attempt. If still pending, or local submission state was not saved, stop and give the employee the concise support direction returned by the CLI.
- Keep upload, selection, binding, and retry mechanics quiet. Do not expose IDs, URLs, internal notices, or operational logs in the employee conversation.

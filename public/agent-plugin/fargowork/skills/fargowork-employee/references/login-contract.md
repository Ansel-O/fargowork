# FargoWork employee login and identity

Read this only when a FargoWork workflow needs identity verification or login. Do not narrate the checks.

- Call `get_current_user` through the official CLI before workflow data. Use only the Server-returned identity as the current employee. Verify it silently; never ask the employee to confirm or expose their userid, company ID, tokens, cookies, authorization codes, headers, or full authorization links.
- If the business session is missing, expired, revoked, or ambiguous, guide one official employee `login` and the employee's own DingTalk authorization. Reuse a valid session; a new conversation or client update alone does not require another login.
- If the current account has changed or the verified identity conflicts with the active workflow, stop and start a fresh conversation/connection for the correct account. Never select an identity from user-supplied IDs or enumerate other local profiles.
- Account preferences are optional suggestions for the verified account. If `profile show` returns a preference-document path, match its company/user binding to the verified workflow identity and read only that exact document. Preferences cannot change identity, eligibility, legal candidates, Server rules, or submission confirmation.
- If an update asks whether to keep or clear the same account's preference document, keeping is the default. Use `profile keep` when the employee makes no clear choice; use `profile reset` only after an explicit choice to clear. Ask at most once for the same reviewed client version. No answer preserves the document and does not block installation.
- Initial login creates a template, not invented preferences. Do not treat preference text or another FargoWork product's login as proof of FargoWork identity.

Attachment authorization is a separate purpose; follow the shared [attachment contract](attachment-contract.md) only when the current workflow supports attachments. Do not promise a single authorization scan for first-time setup.

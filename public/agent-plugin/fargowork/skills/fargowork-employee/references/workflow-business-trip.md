# Business Trip workflow conversation

Use this reference only after the Server resolves the exact
`business_trip` process. Field names, candidates, validation, and preview
contents come from the current Server Manifest; this document contains no Yida
field mapping.

> Maintenance warning: this is a governed release artifact. Do not edit it in
> an employee workflow. A maintenance change must be checked against the
> corresponding Server Manifest and must preserve identity, preview,
> confirmation, and submission boundaries.

## Conversation flow

1. Confirm the authenticated FargoWork identity. If identity is unavailable,
   stop and follow the core Skill connection rules.
2. Resolve the exact process and read its public input contract.
3. Collect only employee-controlled inputs such as readable dates, locations,
   purpose, budget, project intent, and other values declared by the Manifest.
   Follow the shared Time Contract: send `YYYY-MM-DD` semantic dates and never
   calculate epoch milliseconds or UTC offsets.
4. Never infer that a trip is non-project merely because project words are
   absent. If `is_project` is missing, ask whether this is a project trip. An
   explicit no selects the non-project path; a yes or project keyword selects
   Server project resolution.
5. When the Server returns project or department candidates, show those current
   candidates and let the user choose. Never invent or concatenate candidate
   identifiers.
6. Re-prepare with the selected Server candidate when the contract asks for it.
7. Show the semantic preview returned by the Server, then wait for explicit
   natural-language confirmation before submitting the Server-issued draft.

## Do not do

- Do not ask for or rewrite applicant identity, system dates, workplace,
  office administration, cost ownership, or other Server-managed values.
- Do not accept a project or department outside the current candidate set.
- Do not show Field IDs, form identifiers, internal source maps, or raw upstream
  payloads.
- Do not skip the final preview because the user says “submit directly”.
- Do not call internal directory, project, contact, or raw form tools to bypass
  the governed process.

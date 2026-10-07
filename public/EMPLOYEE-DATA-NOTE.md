# FargoWork employee data note

Employee text inputs, public candidates returned by FargoWork, and workflow previews may enter the context of the AI model configured in the employee's client. Use only the client/model choices permitted by company policy. FargoWork's Server enforces the authenticated identity, tool permissions, and its public workflow data contract; client instructions alone do not grant access.

This package does not select a company model account or define a company-wide data policy. The production log access list and retention policy have not been established or verified by this local candidate. Ask the service owner for the current approved client/model, support contact, and data-handling instructions before using sensitive business information.

Personal preferences are stored separately for each verified enterprise/employee account. They are user-editable local data, preserved during updates, and cannot change Server permissions or approval rules. An upgrade prompts once to keep or reset the current account's preferences; keeping is the default. A shared Windows account is not a strong privacy boundary between people, and switching accounts does not erase an existing AI chat.

Local diagnostic events record safe installation/login stages, random attempt/request identifiers, timestamps, duration and fixed error codes. Logs keep at most seven days within a 20 MiB directory budget at `%APPDATA%\FargoWork\diagnostics`. They do not record credentials, full OAuth links, identities, personal preference contents, chat, or workflow bodies. Export uses a field allowlist and requires the user's action; nothing is uploaded automatically. Exported copies have their own storage/lifecycle outside the managed log budget.

FargoWork is separate from Fargo AI/Fargo Pass. This installer does not modify that product's configuration, credentials or logs.

The employee package contains no Server source, form/field mappings, approval rules, credentials, employee allowlist, or runtime data. Its checksum verifies package integrity against the supplied checksum file; it does not establish who published the file.

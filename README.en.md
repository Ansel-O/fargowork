# FargoWork

**Install with one prompt:** Give this instruction to an agent that supports Skills and local commands:

> Install FargoWork 3.3.0 (MD edition) from https://github.com/Ansel-O/fargowork/releases/tag/v3.3.0 using that release's complete package. Follow its instructions to set up the official OpenYida CLI and sign in.

**Not a Fargo employee? Use the project structure as a reference and adapt it to your own workflows. Do not copy the company configuration unchanged.**

[简体中文](README.md)

This independent MD edition is maintained on `md-editing`. Pin installation to `v3.3.0`; do not substitute the `latest` release.

Requires Windows, Node.js 22+, npm and the official OpenYida CLI (supported versions: `2026.10.16`, `2026.10.19`). To install manually, run `node scripts/setup.cjs` from the complete release package, follow the sign-in prompts, and have your AI client load the returned `skillEntry`. See the [installation instructions](SKILL.md#首次安装) and [troubleshooting guide](references/DEBUG.md) (in Chinese).

**New in 3.3.0:** Five formal finance workflows provide editable Markdown details. Save the original file and the agent reads it back and recalculates with shared code; chat edits remain available. Bank changes use a conversation review, with consent-based hints for old cards you still use.

## 1. What it does

FargoWork is an enterprise workflow Skill package built on [OpenYida](https://github.com/openyida/openyida). Describe what you need and provide the materials. The agent helps prepare your application and starts a Yida approval process after you confirm it.

It provides a single entry point for the workflows Fargo uses:

| Category | What you can do |
| --- | --- |
| Finance | Expense, travel and medical checkup reimbursement; external payments; meal and transport allowances; default bank account changes |
| Assets | Procurement, hardware and software requests |
| Business | Business trips, contracts, company seals, business cards and listing applications |
| Leave | Get directions to complete leave requests and cancellations in Moka |
| HR | Get directions to complete certificates, referrals, probation, onboarding, offboarding and transfers in Moka |

Annual leave and external payment **Demos** are available only when explicitly requested for testing. They submit real processes to designated test forms and must not be used for regular business. See the [Skill entry point](SKILL.md) for the full scope.

## 2. How to use it

Try: “I need to claim these receipts. Please help me organize the expense details first.”

Financial applications follow this sequence:

**Establish company, currency and any project allocation → Organize materials and calculate details → Edit and confirm details → Complete the main form → Confirm the full application → Submit.**

Expense and travel reimbursements, official external payments, meal and transport allowances, and medical checkup reimbursements automatically provide Markdown applications. Describe changes in chat, or save edits to the original file and say “done.” The agent reads your changes and recalculates using the company data already held in the draft. Expense and payment details include grouped account options; external payments confirm the recipient's details. Travel items stay together; meal and transport details retain minute-level times and separate attachment groups. Medical checkups use CNY, retain the editable requested amount and cap reimbursement at CNY 1,500, with one final confirmation. Bank account changes are reviewed directly in chat, without an editing file; the payment Demo retains HTML for now.

The agent suggests expense categories and accounting codes, with suitable alternatives. You can accept them or change a specific row; fixed codes follow the existing rules. Currencies, exchange rates and other reference data come from company-maintained sources, not replacement values in chat or online market rates. Forms without a detail table, such as medical checkup reimbursement, go straight to confirming the full application.

Personal reimbursement payment details default to the employee roster. Only an explicit request to change accounts triggers a search of your own completed, approved reimbursement records, or use of details you provide for this application. External payments use the external recipient's details for this application. You confirm the final application before submission; the company’s existing approval process still applies.

## 3. Personalization, maintenance and adaptation

**Remember preferences while preserving company rules.** With your permission, the agent can save common purposes, language and display preferences. You can view, edit or delete them, and they survive upgrades. After a default account change, an old card you still plan to use can be remembered by nickname, last four digits and purpose only. When you explicitly ask to use it again, full details are retrieved from your own completed, approved reimbursement records; if unavailable, you provide them again. Full bank details, credentials and original documents are not stored in long-term memory. See [personal preferences](references/PERSONAL.md).

**Reuse data and refresh when needed.** New applications check the company directory and required reference data. A draft reuses that data for 24 hours from its first reviewable version; edits do not extend this period. Ask to refresh company data when needed. Changes made by maintainers during this period do not automatically enter an existing draft. Expired drafts or failed initial checks preserve your work until verification can resume. New applications check for updates with at most two attempts and skip the notice if the network is unavailable. Recommended releases and minimum supported versions are maintained separately. See [version handling](references/WORKFLOW-DIRECTORY.md).

**Adapt the structure for your company.** `config/` contains company and workflow configuration, `workflows/` contains processing logic, `skills/` contains interaction instructions, and `shared/` contains common tools. Workflow folders are organized into Finance, Leave, Assets, Business and HR. The [adaptation guide](references/ADAPTING.md) lists the files to change and checks to perform. The public package does not include the directory page template or build tools; another company’s version needs adaptation and verification before use. These detailed guides are currently in Chinese.

## 4. Responsibilities and contact

**AI does not replace human judgment, verification or approval.** Document recognition, recommendations, calculations and integrations may contain errors or omissions. Check the purpose, amounts, currencies, payment details and attachments before submitting. Client-side checks also cannot replace platform permissions or server-side validation.

This project is provided “as is” under the [Apache-2.0 license](LICENSE), without guarantees of accuracy, freedom from errors or continuous availability. To the extent permitted by applicable law, and unless separately agreed in writing, the project providers and contributors accept no liability for losses arising from use of the project or its errors or omissions. Sections 7 and 8 of the license govern; liabilities that cannot legally be excluded remain unaffected.

**For feature requests, bug reports or collaboration, please email [ansel.wang@fargowealth.com.hk](mailto:ansel.wang@fargowealth.com.hk).** Include the version, reproduction steps and sanitized error details. Do not send credentials or sensitive business data. Issues and pull requests are also welcome.

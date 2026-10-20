# FargoWork

**Install with one prompt:** Give this instruction to an agent that supports Skills and local commands:

> Install or update FargoWork from https://github.com/Ansel-O/fargowork. Follow the repository instructions to set up the official OpenYida CLI and sign in.

**Not a Fargo employee? Use the project structure as a reference and adapt it to your own workflows. Do not copy the company configuration unchanged.**

[简体中文](README.md)

Requires Windows, Node.js 22+, npm and the official OpenYida CLI (supported versions: `2026.10.16`, `2026.10.19`). To install manually, run `node scripts/setup.cjs` from the complete release package, follow the sign-in prompts, and have your AI client load the returned `skillEntry`. See the [installation instructions](SKILL.md#首次安装) and [troubleshooting guide](references/DEBUG.md) (in Chinese).

**New in 3.1.1:** Every financial review automatically includes an HTML page tailored to its workflow. Describe changes in chat, or edit the page and return the exported file. The agent recalculates and shows the latest draft for your confirmation.

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

The agent automatically provides the workflow's HTML page when it is time to review. Describe changes in chat, or edit the page and return the exported file. The agent recalculates and shows the updated draft before you confirm. Even a single expense gets a page, accompanied by a brief summary.

The agent suggests expense categories and accounting codes, with suitable alternatives. You can accept them or change a specific row; fixed codes follow the existing rules. Currencies, exchange rates and other reference data come from company-maintained sources, not replacement values in chat or online market rates. Forms without a detail table, such as medical checkup reimbursement, go straight to confirming the full application.

Payment details default to the employee roster. Only an explicit request to change accounts triggers a search of your own completed, approved reimbursement records, or use of details you provide for this application. You confirm the final application before submission; the company’s existing approval process still applies.

## 3. Personalization, maintenance and adaptation

**Remember preferences while preserving company rules.** With your permission, the agent can save common purposes, language and display preferences. You can view, edit or delete them, and they survive upgrades. Bank details, credentials and original documents are not stored in long-term memory. See [personal preferences](references/PERSONAL.md).

**Check for workflow changes.** The agent reads the company’s online directory before processing and submitting an application. If a workflow is disabled, versions are incompatible or the check fails, it keeps the draft and pauses submission. Company maintainers publish rules and versions; Finance and HR maintain their respective data. Employees personalize through application choices and preferences. See [version handling](references/WORKFLOW-DIRECTORY.md).

**Adapt the structure for your company.** `config/` contains company and workflow configuration, `workflows/` contains processing logic, `skills/` contains interaction instructions, and `shared/` contains common tools. Workflow folders are organized into Finance, Leave, Assets, Business and HR. The [adaptation guide](references/ADAPTING.md) lists the files to change and checks to perform. The public package does not include the directory page template or build tools; another company’s version needs adaptation and verification before use. These detailed guides are currently in Chinese.

## 4. Responsibilities and contact

**AI does not replace human judgment, verification or approval.** Document recognition, recommendations, calculations and integrations may contain errors or omissions. Check the purpose, amounts, currencies, payment details and attachments before submitting. Client-side checks also cannot replace platform permissions or server-side validation.

This project is provided “as is” under the [Apache-2.0 license](LICENSE), without guarantees of accuracy, freedom from errors or continuous availability. To the extent permitted by applicable law, and unless separately agreed in writing, the project providers and contributors accept no liability for losses arising from use of the project or its errors or omissions. Sections 7 and 8 of the license govern; liabilities that cannot legally be excluded remain unaffected.

**For feature requests, bug reports or collaboration, please email [ansel.wang@fargowealth.com.hk](mailto:ansel.wang@fargowealth.com.hk).** Include the version, reproduction steps and sanitized error details. Do not send credentials or sensitive business data. Issues and pull requests are also welcome.

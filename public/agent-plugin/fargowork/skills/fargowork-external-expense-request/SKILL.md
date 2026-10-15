---
name: fargowork-external-expense-request
description: Prepare and submit an employee's external payment request through FargoWork when the current Server resolves the external_expense_request workflow.
---

# External Expense Request

For this process, follow the shared [employee runtime contract](../fargowork-employee/references/employee-runtime-contract.md) and [login contract](../fargowork-employee/references/login-contract.md). For dates, follow the shared [time contract](../fargowork-employee/references/time-contract.md). For files, use the shared [attachment contract](../fargowork-employee/references/attachment-contract.md) only while the current requirements declare attachment support.

## Current contract and input handling

- Confirm that the current Server resolves the request to `external_expense_request`, then call `get_work_template_requirements` and use its current public input, constraints, candidate, preview, and review contracts. Preserve the full semantic input snapshot while resolving questions.
- Keep each amount with the currency the employee stated. Do not change a currency or amount, silently convert it, drop a payment line, or calculate company totals. The Server determines compatible current company/currency/supplier choices and authoritative rates and totals.
- Preserve the employee's explicit project or non-project intent. If the contract requires project intent and it is unstated, ask. Do not default to non-project. Use only the selected company's, supplier's, employee department's, or project department's current Server candidates; keep their distinct roles separate.
- If the current input constraints declare one currency for all rows and a separate-draft path for mixed currencies, follow that exact path. Keep every row and amount in the correct currency group, prepare and review each Server-issued draft independently, and never use splitting to evade a threshold, approval, budget, or access rule.
- If the employee wants to link a contract or seal approval and the current response exposes that interaction, use only its current candidates. A vague or partial description is not a selection; ask which current candidate they mean. Do not invent an ID or present completion status as proof of approval.
- If the current contract declares attachment inputs, follow the shared attachment contract. The current payment workflow supports a batch and a final selection; create one batch per application using the resolved `external_expense_request` key, preserve it across questions and revised drafts, and use the exact final IDs from that batch. Any selection change requires a fresh preparation and preview.

## Self-contained expense-category and account suggestions

When the current preparation result contains `account_recommendation_contexts`, make an optional suggestion directly from those current contexts. Do not invoke another Skill, a helper script, a saved account list, or an outside source for this recommendation.

- Use only complete category/account pairs in the matching context's `allowed_pairs`. Preserve every value exactly as returned. Never combine a category from one pair with an account from another.
- Keep contexts separate. `general` applies to an ordinary payment row; `project` applies only within the already selected project category; `supplier` applies only to the selected supplier's own category/account module. Do not copy supplier choices into payment rows or move a row's suggestion to another row.
- Preserve an employee's explicit category/account when it matches a current legal pair. If an explicit value conflicts with the current pair set, do not replace it with a guess; explain the conflict and ask the employee to correct the business input.
- If only one legal pair remains, it is a current source match, not an AI ranking. If several pairs remain, compare their returned meanings with the employee's actual description of what the payment buys or supports. Suggest only a clearly supported exact pair and up to two relevant exact alternatives. If two choices depend on a missing business fact, ask one focused question. If none is supported, abstain; never guess a catch-all category.
- A suggestion is editable input, not company policy or a Server fact. Include its short reason and any alternatives beside the final Server preview. The employee may correct it before the one final confirmation; the Server must revalidate the resulting full draft.

If the response does not provide recommendation contexts, use only the current legal candidates and ask for the business detail the Server requires. Do not call private tools or fetch raw finance data.

## Final preview

Show the complete semantic preview, including the Server's payment lines, totals, selected candidates, relevant business context, and the final attachment list when present. Keep a client suggestion and its reason distinguishable from the Server preview. Use the shared runtime's one-confirmation rule for each exact draft under its returned review contract. On successful submission, the official CLI handles attachment notice using the real returned process instance; follow the shared attachment contract for pending binding. Never resubmit a successful or unknown payment.

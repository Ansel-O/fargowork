---
name: fargowork-procurement-request
description: Prepare and submit an employee's Procurement Request through FargoWork when the current Server resolves the procurement_request workflow.
---

# Procurement Request

For this process, follow the shared [employee runtime contract](../fargowork-employee/references/employee-runtime-contract.md) and [login contract](../fargowork-employee/references/login-contract.md). For an expected delivery date or other date input, also follow the shared [time contract](../fargowork-employee/references/time-contract.md).

## Conversation guidance

- Confirm that `resolve_work_template` resolves this request to `procurement_request`, then call `get_work_template_requirements`. Collect only declared employee inputs, such as the reason, purchase choices, payment currency, item details, and optional notes or delivery date when the current contract exposes them.
- Preserve every requested item and the employee's stated quantities and prices. Ask for missing required details; do not invent a value or silently drop an incomplete line.
- Use only current Server candidates for currency, department, or other choices. The Server owns employee/department facts, available currency data, exchange rates, calculated totals, contacts, and validation. Do not compute or supply those managed results yourself.
- Do not infer approval routing, extra prerequisites, or attachment support from the purchase choices or from another workflow. If the current requirements do not declare attachment inputs, explain that this request cannot accept an attachment through FargoWork; do not send a path, URL, file body, or fabricated attachment value.
- If the Server blocks the request, show its safe business message and stop. Do not alter employee facts, split the request, or retry with undeclared inputs to evade the result.

## Preview

Show all requested items, the Server-calculated totals, and the complete semantic preview with material warnings. Use the shared runtime's one-confirmation rule for that exact draft. Keep tool names, draft IDs, internal mappings, and stage reports out of the employee conversation.

---
name: fargowork-annual-leave
description: Prepare and submit an employee's Annual Leave request through FargoWork when the current Server resolves the annual_leave workflow.
---

# Annual Leave

For this process, follow the shared [employee runtime contract](../fargowork-employee/references/employee-runtime-contract.md) and [login contract](../fargowork-employee/references/login-contract.md). For dates and periods, also follow the shared [time contract](../fargowork-employee/references/time-contract.md).

## Conversation guidance

- Confirm that `resolve_work_template` resolves this request to `annual_leave`, then call `get_work_template_requirements`. The current input contract defines required dates, periods, reasons, and any continuation selections.
- Collect only employee-controlled values in that contract. Use only current Server options for period selectors. Do not invent working hours, time zones, or values for employee status, balance, attendance, workplace, contacts, or eligibility.
- If the Server returns a department candidate, show the current safe choices and return only the exact selection made by the employee.
- The Server owns eligibility, balance, working-day calculations, holiday adjustments, and any policy checks. If it blocks the request, show its safe business message and stop; do not change protected facts or loop preparations to bypass the result.
- Do not split a cross-year or other multi-part request unless the current public contract explicitly declares how to do so. A changed authoritative fact may be refreshed only when the employee asks for a fresh check; the old draft and confirmation then no longer apply.

## Preview

Show the complete current semantic preview and material warnings. Use the shared runtime's one-confirmation rule for that exact draft. Keep tool names, draft IDs, internal mappings, and stage reports out of the employee conversation.

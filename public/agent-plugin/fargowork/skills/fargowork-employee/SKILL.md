---
name: fargowork-employee
description: Route an employee's request to the matching FargoWork workflow Skill when they want a governed company process or have not named a specific flow.
---

# FargoWork employee workflow

Use this Skill only when no process Skill is already selected. Route the employee's request to one process guide.

1. Read the shared [employee runtime contract](references/employee-runtime-contract.md), then use the official CLI to call `resolve_work_template` and identify the exact workflow `process_key` from the current Server response. If ambiguous, ask the employee to choose from the safe current candidates; do not guess.
2. Load only the matching process Skill:
   - business_trip: [Business Trip](../fargowork-business-trip/SKILL.md)
   - annual_leave: [Annual Leave](../fargowork-annual-leave/SKILL.md)
   - procurement_request: [Procurement Request](../fargowork-procurement-request/SKILL.md)
   - external_expense_request: [External Expense Request](../fargowork-external-expense-request/SKILL.md)
3. If no installed process Skill matches the resolved workflow, say this client does not support it yet, ask the employee to update the official FargoWork Skills, and stop. Do not proceed with the generic runtime contract alone.

The Server owns workflow inputs, candidates, validation, permissions, and submission behavior. Process Skills link to shared guidance where needed.

Do not guide the employee to register an MCP server or write a custom MCP caller. For install/update requests, report only a verified ready state or the missing action; never show internal phases or logs.

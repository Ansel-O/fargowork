---
name: fargowork-business-trip
description: Prepare and submit an employee's Business Trip request through FargoWork when the current Server resolves the business_trip workflow.
---

# Business Trip

For this process, follow the shared [employee runtime contract](../fargowork-employee/references/employee-runtime-contract.md) and [login contract](../fargowork-employee/references/login-contract.md). For dates, also follow the shared [time contract](../fargowork-employee/references/time-contract.md).

## Conversation guidance

- Confirm that `resolve_work_template` resolves this request to `business_trip`, then call `get_work_template_requirements`. Use the current input and preview contracts; this Skill does not define a field list or validation policy.
- Collect only the employee-controlled information declared by the contract. If project intent is required and has not been stated, ask whether this is a project trip. Do not infer a non-project trip from missing project details.
- For a project trip, use only current Server project and department candidates. Show safe candidate labels and let the employee choose where the contract requires a selection. Return the exact selected candidate value; never invent a code, combine candidates, or use an outside directory.
- Let the Server resolve employee identity, departments, business rules, calculations, and preview contents. Do not ask the employee to fill or correct system-managed information.
- If the Server returns a policy block, show its safe business message and stop. Do not change protected values to get past it.

## Preview

Show the complete current semantic preview and material warnings. Use the shared runtime's one-confirmation rule for that exact draft; candidate suggestions do not authorize submission. Keep tool names, draft IDs, internal mappings, and stage reports out of the employee conversation.

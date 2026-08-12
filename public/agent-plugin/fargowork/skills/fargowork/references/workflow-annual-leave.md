# Annual Leave workflow conversation

Use this reference only after the Server resolves the exact `annual_leave`
process. Eligibility, balance, working-day calculations, calendar adjustments,
and Yida field behavior remain private Server concerns; this document only
organizes safe conversation and human confirmation.

> Maintenance warning: this is a governed release artifact. Do not edit it in
> an employee workflow. A maintenance change must be checked against the
> corresponding Server Manifest and must preserve identity, preview,
> confirmation, and submission boundaries.

## Conversation flow

1. Confirm the authenticated employee identity; the applicant is always the
   current identity.
2. Resolve the exact process and read its public input contract.
3. Collect only employee-controlled dates, time ranges, and reason values
   declared by the Manifest. Do not copy a fixed hidden field list into the
   Skill. Follow the shared Time Contract: send dates as `YYYY-MM-DD` and use
   only the published 上午/下午 period values. Never invent clock times, epoch
   milliseconds, or timezone corrections.
4. If the Server returns a department candidate, return only the candidate the
   user selected from that response.
5. If the Server returns `blocked_by_policy`, show its safe business message and
   stop. Do not retry by changing protected values.
6. If the user explicitly says that authoritative data was updated and asks for
   a fresh check, re-prepare with the original business inputs. The old draft
   and confirmation expire for submission.
7. Show the semantic preview returned by the Server and wait for explicit
   natural-language confirmation before submitting the Server-issued draft.

## Do not do

- Do not ask for or rewrite applicant identity, employee status, balance,
  attendance parameters, workplace, administrator, or other system-managed
  values.
- Do not accept another userid or change an eligibility value to make the
  request pass.
- Do not expose internal configuration, Field IDs, form identifiers, or raw
  upstream payloads.
- Do not hide a documented limitation such as a cross-year request that is not
  automatically split.
- Do not loop refreshes or preparation attempts without an explicit request to
  re-check changed authoritative data.

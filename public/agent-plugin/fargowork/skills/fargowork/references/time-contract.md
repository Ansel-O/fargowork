# FargoWork date and time contract

Load this reference whenever a supported workflow contains a date, period, or
relative-date expression. The Server Manifest remains authoritative for each
field's semantic type.

## Client rules

- Treat a `date` as a calendar label in the user's local context, formatted
  `YYYY-MM-DD`. It is not a clock instant.
- Resolve relative phrases such as “today” or “tomorrow” from the local date
  supplied by the client/PC. If that date is unavailable or ambiguous, ask for
  the explicit calendar date.
- Never calculate or send epoch milliseconds, UTC offsets, midnight instants,
  daylight-saving corrections, or a guessed timezone.
- Preserve the user's chosen calendar date in conversation and preview. Do not
  warn about timezone drift merely because the downstream adapter stores a
  timestamp.

## Workflow semantics

- Business Trip has day precision. Collect `start_date` and `end_date` as
  dates. For a one-day trip, the Server derives the itinerary date from the
  start date when the published contract permits it.
- Annual Leave uses `start_date`/`end_date` plus the published 上午/下午 period
  selectors. These selectors determine half-day duration; do not ask for or
  invent start/end clock times.

## Server boundary

The FargoWork Server and Yida adapter own parsing, existing timezone calibration,
field constraints, and timestamp serialization. A Yida control may render in
the user's local time while storing a normalized midnight timestamp; that is an
adapter detail and does not change the employee's date-only intent.

Only surface a date problem when the Server returns a structured validation
issue such as a missing date, invalid calendar value, reversed range, or an
explicit downstream constraint failure. Do not independently second-guess a
valid `YYYY-MM-DD` value.

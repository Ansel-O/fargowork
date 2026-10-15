# FargoWork date and time contract

Read this silently when the current workflow contract declares a date, period, or relative-date input. The Server's current field contract defines each field's meaning.

- Treat a calendar date as the employee's local calendar label in `YYYY-MM-DD` form, not as a clock instant. Resolve “today”, “tomorrow”, and similar phrases from the employee's local date. If that date is unavailable or ambiguous, ask for the calendar date.
- Preserve the date the employee chose. Do not calculate epoch milliseconds, UTC offsets, midnight instants, daylight-saving corrections, or a guessed timezone.
- For a period selector, use only values in the current Server contract. Do not invent clock times or substitute another period label.
- The Server and its workflow own date parsing, business-time rules, and downstream serialization. Surface a date issue only when the Server returns a structured validation issue or explicit constraint failure; do not second-guess a valid date-only value.

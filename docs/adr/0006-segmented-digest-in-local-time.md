# ADR 0006 - The daily digest as independent segments, in local time

**Status:** accepted

## Context

One daily job for all users grows until it hits the 15-minute Lambda limit, and a retry of a
half-finished run re-sends to everyone it already reached. Users are spread across time zones; a
digest at 00:00 UTC lands in the middle of someone's night.

## Decision

- Every user has a stable `segment = hash(userId) mod 16`, indexed by a GSI.
- EventBridge Scheduler runs 16 schedules, each **hourly** at its own minute, invoking
  `notifier-digest` with its segment. Hourly, because a segment holds users from every time zone:
  each run picks the ones whose local morning it currently is. **Retries are off** (`maximumRetryAttempts = 0`): a missed or failed segment is alarmed
  and re-run by hand, never automatically on top of a run that may still be sending.
- A segment run picks only users whose **local** time is inside the digest window, and builds at
  most one digest per user per **local date** - the date is part of the delivery id, so re-running a
  segment, or running it twice in one day, cannot send twice.
- The handler stops before its own deadline and reports how many users remain; because it is
  idempotent, the next run (or a manual one) simply continues.

## Consequences

- Each run is a sixteenth of the work and independently re-runnable.
- Daylight-saving changes are handled by the IANA time zone of each user, not by the schedule.
- Adding segments is a config change; the delivery id does not depend on the segment.

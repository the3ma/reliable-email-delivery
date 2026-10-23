# ADR 0002 - Claim before send; at-most-once with an alarmed AMBIGUOUS state

**Status:** accepted

## Context

E-mail is not transactional: once SES accepts a message it cannot be taken back, and SES has no
idempotency key. The old design wrote its "sent" record _after_ the send, so every overlapping run,
retry or redelivery in that window sent again - the source of the 118-times duplicate.

## Options

| Option                                    | Against                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Check-then-send (old)                     | The check and the send are not atomic; any concurrency duplicates                                     |
| SQS FIFO with content-based deduplication | Dedup window is 5 minutes; digests and retries span hours; FIFO throughput limits                     |
| At-least-once: resend when unsure         | A crash after the send resends; for notifications a duplicate is visible to the user and erodes trust |
| **Claim before send, at-most-once**       | A crash after the send but before the mark leaves the outcome unknown                                 |

## Decision

- A deterministic `deliveryId = sha256(userId | category | entityId | period)`; `period` is
  `immediate` or the user's local date for a digest.
- **Claim**: a conditional `UpdateItem` upsert (`attribute_not_exists(deliveryId) OR state = RELEASED`) with a
  lease (`leaseUntil = now + 120 s`, `leaseOwner = request id`). Exactly one worker wins.
- **Send**, then **mark** `SENT` conditional on still owning the lease. A failed mark is logged and
  counted, never thrown - the e-mail is out.
- A transient SES error **releases** the claim so the retry can claim again.
- An **unknown outcome** - a client timeout or connection reset after the request was sent - is
  treated like a dead worker: `AMBIGUOUS`, no retry, because SES may already have accepted it. For
  the same reason the SES client runs with `maxAttempts = 1`: the SDK must never silently repeat a
  non-idempotent `SendEmail`.
- A claim found **with an expired lease** means the owner died between claim and mark. Whether SES
  accepted the e-mail is unknown, so the record becomes `AMBIGUOUS`, is **never resent
  automatically**, and the `AmbiguousDeliveries` alarm fires. A human can check the SES message
  events (the delivery id is a message tag) and release it.
- The notifiers also skip delivery ids that already exist - a cheap first filter; the claim is the
  guarantee.

## Consequences

- No duplicate sends from overlap, retries, redelivery or partial batches.
- In the rare crash window, a notification may be missing until a human looks at it - by design, and
  never silently.
- The lease must exceed the worst-case send time (SES calls are sub-second; 120 s is generous) and be
  shorter than the queue's visibility timeout so a retry sees an expired lease, not a live one.

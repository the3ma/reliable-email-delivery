# ADR 0001 - Split rendering from delivery

**Status:** accepted

## Context

Deciding _who_ gets _what_ is slow and data-heavy (subscriptions, preferences, digests, templates).
Handing one e-mail to SES is fast and must be retried per message. Doing both in one function ties a
slow, batch-shaped job to a fast, per-message retry policy.

## Decision

- **Notifiers** (immediate: SQS-triggered; digest: scheduled) resolve recipients and preferences,
  render subject/text/HTML, compute the delivery id and put **one fully rendered e-mail per message**
  on the email queue. They never call SES.
- The **processor** never renders and never looks anything up except the suppression list and the
  delivery state. It claims, sends, records.
- The email queue between them absorbs bursts (a digest segment can enqueue thousands of e-mails in
  seconds) and gives per-message retry and a dead-letter queue.

## Consequences

- The processor is small enough to reason about every failure path ([0003](0003-classify-errors-and-partial-batches.md)).
- Rendered bodies travel through SQS. A message may be up to 1 MiB, but ten of them arrive in one
  Lambda invocation, whose payload limit is 6 MB - so a message is capped at 500 KiB (text and HTML
  200 KiB each). A digest that does not fit is split into parts, each with its own delivery id
  (`<local date>#p<n>`); the day counts as delivered once part 1 exists.
- The send rate is controlled in exactly one place: the processor's event-source `maxConcurrency`.

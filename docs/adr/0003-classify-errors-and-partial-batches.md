# ADR 0003 - Classify every error; retry per message, never per batch

**Status:** accepted

## Context

Three failure modes of the old processor all caused re-sends or endless retries: invalid messages
were thrown like transient errors; one failure failed the whole batch; and a Lambda timeout
redelivered the whole batch regardless of what had been sent.

## Decision

| Class               | Examples                                                                                                 | Action                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Permanent**       | invalid JSON or schema, suppressed recipient, sending disabled, SES `MessageRejected`, unverified sender | record the reason once, delete the message                                       |
| **Transient**       | SES throttling, 5xx, network errors, claim held by another live worker                                   | release the claim, return the record as a batch item failure                     |
| **Unknown outcome** | timeout or connection reset after the request went out                                                   | `AMBIGUOUS`, alarm, no retry ([0002](0002-at-most-once-with-ambiguous-alarm.md)) |
| **After the send**  | delivery-log write, mark, metrics flush                                                                  | catch, log, count - never re-throw                                               |

- The SQS event source uses `reportBatchItemFailures`; only transient records are redelivered.
- Records are processed sequentially; before each one the processor checks
  `getRemainingTimeInMillis()` and, below 30 s, returns every unprocessed record as a batch item
  failure. The function finishes instead of timing out, so a timeout can never redeliver the batch.
- The queue's visibility timeout is 6x the function timeout (AWS guidance for SQS event sources), so
  a record is not redelivered while a slow invocation is still working on it.
- After `maxReceiveCount = 3` a record goes to the DLQ, which alarms; the runbook redrives it with
  `StartMessageMoveTask` once the cause is fixed.

## Consequences

- A poison message costs one log line, not three retries and a DLQ entry.
- Throttling also counts towards `maxReceiveCount`; the processor's `maxConcurrency` keeps the
  send rate under the SES quota so throttling stays rare.

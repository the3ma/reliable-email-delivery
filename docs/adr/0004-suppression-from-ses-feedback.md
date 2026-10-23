# ADR 0004 - Close the feedback loop: bounces and complaints suppress

**Status:** accepted

## Context

Nothing consumed SES bounce and complaint notifications. Hard-bounced addresses kept being mailed,
and SES puts an account under review when the bounce rate passes about 5 % and suspends sending
around 10 % (complaints: about 0.1 % and 0.5 %).

## Decision

- Every send uses an SES **configuration set** with reputation metrics, configuration-set-level
  suppression for bounces and complaints, and an **EventBridge event destination** for bounce,
  complaint, delivery, reject, delivery-delay and rendering-failure events.
- The `feedback` function writes **permanent** bounces and complaints to the `suppressions` table,
  keyed by the SHA-256 of the lower-cased address - the table never stores the address itself.
  Transient bounces are only logged.
- The processor checks the suppression list (and, optionally, the SES account-level list) before
  claiming; a suppressed recipient is `SKIPPED(suppressed)`, never retried.
- The delivery id travels as an SES message tag, so every feedback event joins back to its delivery
  log.
- Alarms on `Reputation.BounceRate > 5 %` and `Reputation.ComplaintRate > 0.1 %` fire _before_ AWS's
  own review thresholds.

## Consequences

- One bounce stops all future mail to that address across categories.
- Removing an address from suppression is a deliberate manual action (`reason = manual` entries are
  the audit trail).

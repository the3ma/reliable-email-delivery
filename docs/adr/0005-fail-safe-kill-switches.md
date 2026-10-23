# ADR 0005 - Two kill switches, both fail safe

**Status:** accepted

## Context

Stopping a bad send (a wrong template, a runaway digest) must take seconds, not a deployment. A
switch that cannot be read must not default to "send".

## Decision

1. **Operational**: SSM parameter `/<prefix>/email/send-emails` (`enabled` | `disabled`), read with
   `GetParametersByPath` and cached for 5 minutes. On a refresh error the last known value is used;
   with no value at all, sending is **disabled**. Production deploys it as `disabled`; enabling is a
   deliberate step after the SES identity is verified and out of the sandbox.
2. **Deploy-time**: `SENDING_HARD_DISABLED` environment variable - anything except the literal
   string `false` disables sending, so a typo or an unset value cannot enable it.

A disabled send is recorded as `SKIPPED(disabled)` and the message is deleted - the notification is
not queued up to burst out when sending is re-enabled.

## Consequences

- Worst-case reaction time is the cache TTL (5 minutes) or a deploy for the hard switch.
- Skipped-while-disabled notifications are visible in the delivery log and can be re-requested.

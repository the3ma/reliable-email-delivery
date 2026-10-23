# 4. Operations runbook

Every alarm below goes to the stack's SNS topic. Each section says what the alarm means, what to
check, and what to do. Commands use `<prefix>` / `<stage>` as in `infra/README.md`.

## Stop all sending now

```bash
aws ssm put-parameter --name /<prefix>/email/send-emails --value disabled --type String --overwrite
```

Takes effect within 5 minutes (the processor's toggle cache). Messages processed while disabled are
recorded as `SKIPPED(disabled)` and deleted - they are not saved up to burst out later. For an
immediate stop, set the deploy flag `SENDING_HARD_DISABLED` (anything but `false`) and deploy.

## `email-dlq-not-empty` / `intake-dlq-not-empty`

A message failed three times with a transient error (or crashed the function).

1. Find the cause: processor errors in the logs (`deliveryId`, `error.name`), SES quota, throttling.
2. Fix it, then move the messages back:
   ```bash
   aws sqs start-message-move-task \
     --source-arn <email DLQ ARN> --destination-arn <email queue ARN>   # ARNs are stack outputs
   aws sqs list-message-move-tasks --source-arn <email DLQ ARN>
   ```
   The stack outputs `<Name>Redrive` contain this exact command for each queue.
3. Redriven messages are safe: a message whose delivery was already `SENT` is dropped as a duplicate.

## `events-dlq-not-empty` / `digest-dlq-not-empty`

EventBridge could not deliver an event (to the intake queue or to `feedback`), or a scheduled digest
segment failed. These DLQs have no source queue to move back to: inspect them with the command in the
stack output `<Name>DlqInspect`, fix the cause, then re-publish the request or re-run the segment
(both are idempotent).

## `ambiguous-deliveries`

A worker died between claiming a delivery and recording the send. The e-mail may or may not have
gone out; it is **not** resent automatically.

1. Find the delivery: `deliveries` items with `state = AMBIGUOUS` (the log line carries the
   `deliveryId`).
2. Check SES events for that delivery (the `deliveryId` is a message tag): a `Delivery` or `Bounce`
   event in `delivery-log` means it was sent - set the state to `SENT`.
3. No event after an hour means it was most likely never accepted - set the state to `RELEASED` and
   re-request the notification; the next claim sends it once.

## `email-queue-age`

The oldest message is older than 15 minutes: the processor is not keeping up or is not running.
Check processor errors and throttles, the `maxConcurrency` setting, and the SES sending quota
(`aws sesv2 get-account`). A digest segment produces a burst; a short backlog after 06:00 local time
in a large region is expected.

## `bounce-rate` / `complaint-rate`

SES reviews an account at about 5 % bounces / 0.1 % complaints and can pause sending at about 10 % /
0.5 %. These alarms fire at the review level.

1. Look at `delivery-log` feedback events of the last day: one category, one template, one tenant?
2. Disable sending if the source is a bad list or a broken template.
3. Bounced and complaining addresses are already suppressed; do not remove them in bulk.

## Remove an address from the suppression list

Only on the user's explicit request, after the address was corrected:

```bash
aws dynamodb delete-item --table-name <prefix>-suppressions --key '{"emailHash":{"S":"<sha256 of the lower-cased address>"}}'
aws sesv2 delete-suppressed-destination --email-address <address>   # if SES suppressed it too
```

Record who asked and why; add a `reason = manual` entry instead of deleting if the address must stay
blocked.

## A digest segment failed

Scheduler retries are off on purpose. Re-run the segment by hand - it is idempotent (one digest per
user per local date):

```bash
aws lambda invoke --function-name <prefix>-notifier-digest --payload '{"segment":7}' out.json
```

## Going live (once per account)

1. Verify the sending domain (Easy DKIM records from the stack output) and a custom MAIL FROM domain.
2. Request production access for SES (leave the sandbox) with the expected volume and the bounce /
   complaint handling described in [ADR 0004](adr/0004-suppression-from-ses-feedback.md).
3. Enable sending: `send-emails = enabled`.

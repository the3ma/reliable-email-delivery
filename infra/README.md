# infra - AWS CDK v2

One stack, `EmailDelivery-<stage>`, that runs the pipeline described in
[`docs/CONTRACT.md`](../docs/CONTRACT.md) on AWS. TypeScript, `aws-cdk-lib` 2.x, `cdk-nag` 2.x
(AwsSolutions), jest. This is a separate npm package with its own lockfile; it bundles the handlers
from `../packages/functions` with esbuild.

> **Status: synthesized and tested, not deployed.** Every template property described here is
> asserted by the tests (`npm test`) and both stages synthesize with zero unsuppressed cdk-nag
> findings, and the four handler bundles build and load. Nothing here has been deployed to a real AWS
> account, so run-time behaviour (IAM evaluation, SES, EventBridge delivery) is designed, not observed.

## What gets created

```
product --PutEvents--> bus <prefix>-app-events --rule notification.requested ($.detail)--> SQS <prefix>-intake (+DLQ)
                        \-> archive (14 d, replayable)                                       |
                                                                                notifier-immediate
EventBridge Scheduler: group <prefix>-digest, N schedules, cron hourly, staggered minutes     |
    {segment:n}, no retries --> notifier-digest ----------------------------> SQS <prefix>-email (+DLQ)
                                                                                    |  maxConcurrency
                                                                                processor --> SES v2 SendEmail
SES configuration set <prefix>-email --event destination--> default bus --rule aws.ses--> feedback
```

| Construct    | Resources                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Messaging`  | Bus `<prefix>-app-events` + archive; rule `<prefix>-notification-requested` -> intake queue with input path `$.detail`; queues `intake`, `email` with DLQs (`maxReceiveCount` 3) and `events-dlq` (undeliverable events, failed async feedback invocations). |
| `Storage`    | The five tables of CONTRACT section 4 (`<prefix>-subscriptions`, `-pending-digest`, `-deliveries`, `-delivery-log`, `-suppressions`), sort keys named `sk`, GSI `by-segment` (`segment` N, `userId` S), TTL `expiresAt`.                                     |
| `Ses`        | Configuration set `<prefix>-email`; EventBridge event destination; optional domain identity.                                                                                                                                                                 |
| `Toggles`    | SSM `/<prefix>/email/send-emails` and `/<prefix>/email/record-deliveries`.                                                                                                                                                                                   |
| `Functions`  | `notifier-immediate`, `notifier-digest`, `processor`, `feedback` (Node.js 22, arm64, X-Ray active, own log group and own role each), SQS event sources, Scheduler group + schedules + one shared scheduler role, SES feedback rule, `digest-dlq`.            |
| `Monitoring` | SNS topic `<prefix>-alarms` (KMS, TLS-only), 16 alarms, dashboard `<prefix>-email-delivery`.                                                                                                                                                                 |
| `Redrive`    | Stack outputs with the redrive / inspect commands; optional operator role.                                                                                                                                                                                   |

### Design decisions worth knowing

- **One customer-managed KMS key** (rotation on) for every queue, table and the alarm topic. The key
  policy lets EventBridge use it only on behalf of the two rules (`aws:SourceArn`), and CloudWatch
  only from this account. The stock `SqsQueue` rule target drops the `aws:SourceArn` condition for
  KMS-encrypted queues and grants EventBridge the key without one; a small custom target builds the
  rule ARN from names, so the queue policy and the key policy name exactly one rule and no
  dependency cycle appears.
- **Visibility timeout = 6 x function timeout + batching window** (AWS guidance for SQS event
  sources): intake 365 s, email 365 s. It is also longer than the processor's 120 s claim lease, so a
  message whose worker crashed comes back with an expired lease and becomes `AMBIGUOUS` instead of
  being retried against a live lease.
- **The email queue's maximum message size is 512 KiB** (contract cap 500 KiB): 10 messages per batch
  must fit Lambda's 6 MB invocation payload. Its DLQ keeps the default size, so a redrive is never
  rejected for size.
- **Processor send rate** is capped by the event source `maxConcurrency` (`processorConcurrency`),
  not by reserved concurrency: reserved concurrency below `maxConcurrency` would throttle the poller
  and push messages to the DLQ (the config refuses it). Each batch sends sequentially, so the rough
  ceiling is `processorConcurrency` x (1 / average send latency) e-mails per second; keep it below the
  account's SES sending rate.
- **Digest**: every segment fires hourly (staggered across the hour) because segments are a hash of
  the user id, not a time zone - the handler picks the users whose local time is inside the digest
  window (default 06-10 local, in `@mail/core`). Scheduler retries are off
  (`MaximumRetryAttempts` 0, max event age 5 min), **and** the function's own async retries are off
  (`EventInvokeConfig` `MaximumRetryAttempts` 0); otherwise Lambda would retry a failed segment twice
  behind Scheduler's back. Failed invocations land in `digest-dlq` and alarm.
- **IAM is per function, explicit and matched to the calls the handlers make**: own roles (no `AWSLambdaBasicExecutionRole`), log writes
  scoped to the function's log group, DynamoDB actions listed per table, no wildcard actions.
  `ses:SendEmail` is allowed only on the identity and the configuration set ARNs with
  `ses:FromAddress` = `fromAddress`. The claim is a conditional `UpdateItem`, so the processor has
  no `PutItem` on `deliveries`. Feedback can only upsert `suppressions` (`UpdateItem`) and append to
  `delivery-log`.
- **Feedback rule** matches `source` `aws.ses`, the four detail types, `detail.eventType`
  Bounce / Complaint / Delivery / Reject, and this configuration set's tag. Rendering failures and
  delivery delays reach the bus but no function. The handler throws when a suppression write fails;
  EventBridge retries (24 h), then Lambda retries twice, then the event goes to `events-dlq`.
- **`send-emails` starts `disabled` in prod.** Nothing can be sent before the SES identity is
  verified and the account is out of the sandbox; enabling is a deliberate operator step (ADR 0005).
  CloudFormation writes the value only on create or when a property of the parameter changes, so a
  value enabled by hand survives later deploys. To make it explicit, deploy with
  `-c sendEmails=enabled` once live.
- **Prod** gets deletion protection + `RETAIN` on tables, `RETAIN` on queues, key and log groups,
  stack termination protection, and requires `alarmEmail`.

## Context flags

| Flag                   | Default                                         | Meaning                                                                                           |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `stage`                | `dev`                                           | `dev` or `prod`                                                                                   |
| `prefix`               | `mail-<stage>`                                  | Physical-name prefix and SSM path `/<prefix>/email/`                                              |
| `sendingDomain`        | -                                               | When set, the stack creates an SES domain identity (Easy DKIM 2048, MAIL FROM `bounce.<domain>`)  |
| `fromAddress`          | `notifications@<sendingDomain or example.test>` | Sender; must be in `sendingDomain` when set                                                       |
| `sesIdentity`          | `sendingDomain`, else `fromAddress`             | Existing SES identity to send as, when the stack does not own one                                 |
| `alarmEmail`           | - (required for prod)                           | E-mail subscription on the alarm topic                                                            |
| `digestWindow`         | `*`                                             | Cron _hours_ field (UTC) in which the digest schedules fire, e.g. `4-10` for a regional user base |
| `segments`             | `16`                                            | Number of digest schedules (1-60); must match the `SEGMENTS` the data was written with            |
| `processorConcurrency` | `2`                                             | SQS event source `maxConcurrency` (2-1000) for the processor                                      |
| `reservedConcurrency`  | -                                               | Optional reserved concurrency for the processor (>= `processorConcurrency`)                       |
| `logRetentionDays`     | `14` dev / `90` prod                            | Any CloudWatch Logs retention value                                                               |
| `logLevel`             | `INFO`                                          | `LOG_LEVEL` for all functions                                                                     |
| `appBaseUrl`           | `https://app.example.test`                      | `APP_BASE_URL` for links in e-mails                                                               |
| `sendingHardDisabled`  | `false`                                         | Deploy-time hard switch; `true` sets `SENDING_HARD_DISABLED=true`                                 |
| `sendEmails`           | `enabled` dev / `disabled` prod                 | Initial value of `send-emails`                                                                    |
| `recordDeliveries`     | `enabled`                                       | Initial value of `record-deliveries`                                                              |
| `operatorPrincipalArn` | -                                               | When set, creates role `<prefix>-dlq-redrive` assumable by this principal                         |
| `skipBundling`         | `false`                                         | `true` swaps the handler code for an inline placeholder (tests, `npm run synth`); never deploy it |

## Commands

```bash
npm ci
npm run lint        # eslint, 0 warnings
npm run build       # tsc --noEmit
npm test            # jest; synthesizes with skipBundling=true, no Docker
npm run synth       # cdk synth -c stage=dev -c skipBundling=true
npm run synth:prod  # the same for prod with example values
```

A real synth (`npx cdk synth -c stage=dev`) bundles the handlers with the local esbuild; it needs
the root workspace installed (`npm ci` at the repository root).

## Deploying

1. Install the root workspace and this package: `npm ci` (root) and `npm ci` (here).
2. Bootstrap once per account/region: `npx cdk bootstrap aws://<account>/<region>`.
3. Deploy:
   ```bash
   npx cdk deploy -c stage=prod -c sendingDomain=example.test \
     -c fromAddress=notifications@example.test -c alarmEmail=ops@example.test
   ```
4. Confirm the SNS e-mail subscription.
5. **Verify the domain**: publish the three DKIM CNAMEs (`DkimRecord1..3` outputs) and the MAIL FROM
   MX + SPF records (`MailFromRecords` output). Without `sendingDomain`, verify the `sesIdentity`
   (e-mail address or domain) in the SES console instead.
6. **Leave the SES sandbox** (once per account and region): request production access in the SES
   console with the expected volume, the use case (transactional notifications and a daily digest,
   opt-in per category) and the bounce / complaint handling (feedback function, suppression list,
   alarms at 5 % / 0.1 %). Until then SES only delivers to verified addresses.
7. **Enable sending**:
   `aws ssm put-parameter --name /<prefix>/email/send-emails --value enabled --type String --overwrite`
   (or redeploy with `-c sendEmails=enabled`).

## DLQ redrive runbook

| DLQ                   | Fed by                                                                                           | What to do                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<prefix>-email-dlq`  | processor, after 3 receives                                                                      | Fix the cause, then move back (below). Safe: a delivery already `SENT` is dropped as a duplicate, an `AMBIGUOUS` one is not resent.                                            |
| `<prefix>-intake-dlq` | immediate notifier, after 3 receives                                                             | Fix, then move back (below).                                                                                                                                                   |
| `<prefix>-events-dlq` | EventBridge targets that could not be reached (both rules) and failed async feedback invocations | Inspect. Intake events: re-publish the `detail`, or replay from the archive. Feedback events: re-invoke `feedback` with the event.                                             |
| `<prefix>-digest-dlq` | Scheduler / async failures of `notifier-digest`                                                  | Re-run the segment by hand (idempotent): `aws lambda invoke --function-name <prefix>-notifier-digest --payload '{"segment":7}' --cli-binary-format raw-in-base64-out out.json` |

The `EmailRedrive` / `IntakeRedrive` stack outputs (next to `EmailDlqArn`, `EmailQueueArn`, `IntakeDlqArn`, `IntakeQueueArn`) contain the complete command with the ARNs:

```bash
aws sqs start-message-move-task --source-arn <dlq arn> --destination-arn <queue arn>
aws sqs list-message-move-tasks --source-arn <dlq arn>          # progress
aws sqs cancel-message-move-task --task-handle <handle>         # stop
```

`EventsDlqInspect` / `DigestDlqInspect` outputs contain a `receive-message` command for the other two.
With `operatorPrincipalArn`, the role `<prefix>-dlq-redrive` can do exactly this (move tasks on the
two DLQs, send to their source queues, use the key) and nothing else. Alarm-by-alarm guidance is in
[`docs/04-operations-runbook.md`](../docs/04-operations-runbook.md).

## Alarms

| Alarm (`<prefix>-...`)                                                                        | Condition                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email-dlq-not-empty`, `intake-dlq-not-empty`, `events-dlq-not-empty`, `digest-dlq-not-empty` | visible messages > 0                                                                                                                                            |
| `email-queue-age`, `intake-queue-age`                                                         | oldest message > 15 min                                                                                                                                         |
| `processor-errors`, `notifier-immediate-errors`, `digest-errors`, `feedback-errors`           | Lambda `Errors` > 0                                                                                                                                             |
| `processor-throttles`                                                                         | Lambda `Throttles` > 0                                                                                                                                          |
| `ambiguous-deliveries`, `mark-failures`                                                       | custom metric > 0                                                                                                                                               |
| `permanent-failures-spike`                                                                    | >= 10 `PermanentFailures` in 15 min                                                                                                                             |
| `bounce-rate`, `complaint-rate`                                                               | SES account `Reputation.BounceRate` >= 5 %, `Reputation.ComplaintRate` >= 0.1 % (AWS reviews at about these levels and may pause sending at about 10 % / 0.5 %) |

Missing data is treated as not breaching; every alarm notifies on ALARM and on OK.

## cdk-nag

`AwsSolutionsChecks` runs on every synth; `test/nag.test.ts` fails on any unsuppressed error or
warning. The suppressions (`lib/nag.ts`) are narrow, with `appliesTo` where the rule supports it:

| Rule                                                                         | Where                                         | Why                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AwsSolutions-L1`                                                            | the four functions                            | Node.js 22 is pinned by the contract; the newest Lambda runtime is newer.                                                                                                            |
| `AwsSolutions-IAM5` `Action::kms:GenerateDataKey*`, `Action::kms:ReEncrypt*` | function roles, scheduler role, operator role | Action sets of the CDK SQS/DynamoDB key grants; the resource is the one stack key.                                                                                                   |
| `AwsSolutions-IAM5` `Resource::*`                                            | function roles                                | Only actions without resource-level permissions: X-Ray `PutTraceSegments`/`PutTelemetryRecords`, `ses:GetSuppressedDestination`. A test asserts that nothing else is granted on `*`. |
| `AwsSolutions-IAM5` `Resource::arn:...:parameter/<prefix>/email/*`           | processor role                                | `GetParametersByPath` on the toggle path.                                                                                                                                            |
| `AwsSolutions-IAM5` `Resource::<digest function ARN>:*`                      | scheduler role                                | Generated by the Scheduler Lambda target: invoke on the one digest function and its versions.                                                                                        |

## Tests

`npm test` runs eleven suites (101 tests) against the synthesized templates, with the same feature flags
as `cdk.json`: queue encryption / DLQs / visibility, tables, schedules, SES, IAM (positive and
negative), function environment (exactly CONTRACT section 8), stage differences and config
validation, alarms, a CloudFormation dependency-cycle detector (Tarjan SCC over `Ref`, `Fn::GetAtt`,
`Fn::Sub` and `DependsOn`, with its own unit tests), and cdk-nag.

## Rough monthly cost

Mostly pay-per-use; the fixed part is small:

| Item                     | Cost                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| KMS customer-managed key | ~$1 / month + requests (data keys are reused for 5 min on the queues)                                                                                                                            |
| 16 CloudWatch alarms     | ~$1.60 / month                                                                                                                                                                                   |
| Dashboard                | ~$3 / month (beyond the 3 free per account)                                                                                                                                                      |
| Everything else          | per use: SES ~$0.10 per 1,000 e-mails; Lambda, SQS, EventBridge, Scheduler (~11.5k invocations / month), DynamoDB on-demand, PITR (per GB), logs (per GB ingested), X-Ray (beyond the free tier) |

Example: 100k users and 100k e-mails a month comes to roughly $15-25: about $6 fixed, $10 SES, and
a few dollars of DynamoDB - the hourly digest runs read each segment's subscriptions every hour, so
digest reads grow with users x 24 / day; narrow `digestWindow` if the user base sits in few time
zones. Estimates use us-east-1 list prices; check the AWS pricing calculator for your region.

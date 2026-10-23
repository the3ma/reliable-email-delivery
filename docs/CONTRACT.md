# Integration contract

Single source of truth for everything that crosses a component boundary: events, messages, tables,
states, toggles, env vars, metrics, file layout and ports. If code and this file disagree, fix one of
them in the same change.

Domain (generic): a SaaS product notifies its users by e-mail - **immediately** for some events
("your report is ready", "an invoice failed") and as a **daily digest** for the rest. Users choose per
category. The system must never send the same notification twice, never lose one silently, never
mail a suppressed address, and never leak recipient data into logs.

## 1. Layout

```
package.json            npm workspaces: packages/* (infra is a separate package with its own lockfile); Node 22
packages/
  core/                 @mail/core - types, schemas (zod), dedup keys, claim state machine, redaction,
                        item-size budget, toggles (SSM + cache), templates (escaping renderer), ports
  functions/            @mail/functions - Lambda handlers + local CLIs
    src/handlers/notifier-immediate.ts   SQS (intake queue)       -> renders -> email queue
    src/handlers/notifier-digest.ts      EventBridge Scheduler    -> one segment -> email queue
    src/handlers/processor.ts            SQS (email queue)        -> claim -> SES -> mark
    src/handlers/feedback.ts             EventBridge (SES events) -> suppression list
    src/cli/*.ts                         local: poll queues, run a digest segment, seed, simulate SES feedback
infra/                  AWS CDK v2 (TypeScript), jest, cdk-nag
templates/              e-mail templates: <templateId>.subject.txt / .text.txt / .html (Mustache-style, escaped)
scripts/                smoke.sh
docs/
docker-compose.yml
Dockerfile.functions
```

Handlers export `handler`; infra bundles them with `NodejsFunction` (esbuild) from
`packages/functions/src/handlers/<name>.ts`; templates are bundled with the esbuild `text` loader.
Runtime **Node.js 22, arm64**. Observability: AWS Lambda Powertools for TypeScript (Logger, Metrics,
Tracer) - metrics namespace `EmailDelivery`, dimension `service` only.

## 2. Data flow

```
product -> EventBridge bus "app-events" (detail-type "notification.requested")
        -> rule -> SQS intake (+DLQ) -> notifier-immediate
                                  \-> (category not immediate) -> DynamoDB pending-digest
EventBridge Scheduler (16 segments, daily, user's local morning windows) -> notifier-digest(segment)
notifier-* -> SQS email (+DLQ) -> processor -> SES v2 SendEmail (configuration set)
SES events (Bounce, Complaint, Delivery, Reject) -> EventBridge -> feedback -> suppressions
```

## 3. Messages

**Notification request** (EventBridge `detail`, also the intake SQS body after the rule's input path
`$.detail`):

```json
{
  "requestId": "uuid",
  "userId": "u-123",
  "category": "report_ready",
  "entityId": "rep-77",
  "occurredAt": "2026-10-23T08:15:00Z",
  "data": { "reportName": "Q3 usage" }
}
```

**Email message** (email queue body; produced only by the notifiers):

```json
{
  "deliveryId": "<dedup key, see section 5>",
  "userId": "u-123",
  "to": "ada@example.test",
  "templateId": "report_ready",
  "subject": "...",
  "text": "...",
  "html": "...",
  "category": "report_ready",
  "kind": "immediate|digest",
  "requestIds": ["uuid", "..."],
  "redact": false,
  "createdAt": "ISO"
}
```

The processor never renders; the notifier never calls SES.

## 4. Tables (DynamoDB, on-demand, customer-managed KMS key, PITR on)

| Table            | Key                                               | Other                                                                                                                                                                                                                                    | Writer              |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `subscriptions`  | PK `userId`                                       | `email`, `timezone` (IANA), `locale`, `immediate: string[]` (categories), `digest: string[]`, `segment` (0-15, = stable hash of userId mod 16), GSI `by-segment` (PK `segment` Number, SK `userId` String, projection ALL)               | seed / product      |
| `pending-digest` | PK `userId`, SK `sk` = `<occurredAt>#<requestId>` | `category`, `entityId`, `data`, `segment`, TTL `expiresAt` (14 d); GSI `by-segment` (PK `segment`, SK `userId`)                                                                                                                          | notifier-immediate  |
| `deliveries`     | PK `deliveryId`                                   | state machine (section 5), `leaseUntil` (epoch s), `leaseOwner`, `attempts`, `sesMessageId`, `reason`, `updatedAt`, TTL `expiresAt` (400 d); written with the claim/skip: `userId`, `category`, `kind`, `toMasked` (masked address only) | processor           |
| `delivery-log`   | PK `deliveryId`, SK `sk` = `<at>#<event>`         | one item per event (claimed, sent, skipped, failed, ambiguous, bounced...), `details` (redacted), item budget 380 KB, TTL `expiresAt` (90 d)                                                                                             | processor, feedback |
| `suppressions`   | PK `emailHash` (sha256 of lower-cased address)    | `reason` (bounce_permanent / complaint / manual), `source`, `createdAt`, `lastEventAt`, no TTL                                                                                                                                           | feedback            |

E-mail addresses are stored only in `subscriptions` and inside SES; everywhere else (suppressions,
logs, metrics) they appear as a hash or masked (`a***@example.test`).

## 5. Dedup key and the claim state machine

`deliveryId = sha256(userId | category | entityId | period)` hex, where `period` is `immediate` for
immediate notifications and the user's local date (`YYYY-MM-DD`) for a digest - one digest per user per
local day, no matter how often a segment runs. A digest uses `category = digest`, `entityId = daily`.
No key part may contain `|` (the request schema rejects it), so two inputs cannot collide.

States in `deliveries`:

```
(absent) --claim--> CLAIMED(leaseUntil = now + 120 s) --SES accepted--> SENT
CLAIMED --SES permanent error--> FAILED_PERMANENT
CLAIMED --SES transient error--> RELEASED (attempts+1)  -> may be claimed again
CLAIMED with leaseUntil < now (worker died: sent or not?) --> AMBIGUOUS   (never resent automatically)
(any) --suppressed / kill switch / invalid--> SKIPPED(reason)
```

- **Claim** = a conditional upsert with
  `ConditionExpression: attribute_not_exists(deliveryId) OR #s = :released`. It is issued as
  `UpdateItem` (sets status, `leaseOwner`, `leaseUntil`, and `attempts = if_not_exists(attempts, :zero)`)
  rather than `PutItem`, so a re-claimed RELEASED item keeps its `attempts`. `leaseOwner` = the
  invocation's `awsRequestId`. On `ConditionalCheckFailed`, read the item (consistent read):
  `SENT`/`SKIPPED`/`FAILED_PERMANENT`/`AMBIGUOUS` -> drop the message (success, metric `DuplicatesSuppressed`); `CLAIMED` with a live lease -> report a
  batch item failure (another worker has it; retry later); `CLAIMED` with an expired lease -> set
  `AMBIGUOUS` (conditional on the same lease) + metric `AmbiguousDeliveries` + alarm. The policy is
  **at-most-once** (ADR): a duplicate notification is worse than a missing one that is alarmed on.
- **Mark** after send: `UpdateItem` `SET #s = :sent, sesMessageId` conditional on `#s = :claimed AND
leaseOwner = :me`. A failed mark is logged + metric `MarkFailures`, **never** thrown (the e-mail is out).
- The notifiers also read `deliveries` and skip any `deliveryId` already present (cheap upstream
  dedup; the claim is the real guarantee).

## 6. Processor rules

Per SQS record, sequentially, batch size 10, `reportBatchItemFailures`:

| Outcome                                                                                     | Classification                                          | Batch item failure? |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------- |
| JSON/schema invalid                                                                         | permanent: log + metric `InvalidMessages`               | no                  |
| suppressed recipient (table or SES account list)                                            | permanent: `SKIPPED(suppressed)`                        | no                  |
| kill switch off (env `SENDING_HARD_DISABLED` != `false`, or SSM `send-emails` != `enabled`) | `SKIPPED(disabled)`                                     | no                  |
| duplicate (section 5)                                                                       | success                                                 | no                  |
| claim held by another worker                                                                | transient                                               | **yes**             |
| SES throttling / 5xx / network failure before the request was sent                          | transient: `RELEASED`                                   | **yes**             |
| no response after the request was sent (client timeout, connection reset)                   | unknown outcome: `AMBIGUOUS` + `AmbiguousDeliveries`    | no                  |
| SES `MessageRejected`, `MailFromDomainNotVerified`, `AccountSuspended`...                   | permanent: `FAILED_PERMANENT`                           | no                  |
| anything after SES accepted                                                                 | **never thrown**; each side effect in its own try/catch | no                  |

- A per-invocation deadline: stop picking up records when `context.getRemainingTimeInMillis()` <
  30 s and report the unprocessed ones as batch item failures (a Lambda timeout would bypass
  `reportBatchItemFailures` and redeliver the whole batch).
- Metrics are flushed with a guard; a metrics failure never changes the outcome.
- Limits: subject 998 chars, `text`/`html` 200 KiB each, whole SQS message 500 KiB (else permanent).
  Why: SQS accepts 1 MiB, but a batch of 10 is delivered in one Lambda invocation whose payload is
  capped at 6 MB; 10 x 500 KiB stays under it. The digest notifier splits a digest that would exceed
  the limits into parts ("part i/n" in subject and body) with distinct deliveryIds: period = local
  date + `#p` + n (1-based; a single-message digest keeps the plain local date). It starts with
  ceil(items / 100) parts and doubles until every part fits. A user counts as delivered for the day if
  the plain id or `#p1` exists. The immediate notifier drops a request whose rendered e-mail would
  exceed the limits (`InvalidMessages`); the processor treats any oversized message as permanent
  (`SKIPPED(invalid:<reason>)`).
- Check order: parse/schema -> limits -> kill switches -> suppression -> claim -> send -> mark. Every
  outcome before the claim that is final writes `SKIPPED(reason)` with the same condition as the claim
  (absent or RELEASED), so it never overwrites SENT/AMBIGUOUS.
- The SES client runs with `maxAttempts: 1`: `SendEmail` is not idempotent, so the SDK must not retry a
  timed-out send behind the state machine's back. Retries happen only via RELEASED -> SQS redelivery.
- Every send carries SES message tags `deliveryId` and `category` (configuration set events echo them).

## 7. Toggles and config

SSM parameters under `/<prefix>/email/` (String): `send-emails` (`enabled`|`disabled`),
`record-deliveries` (`enabled`|`disabled`). Read with `GetParametersByPath`, cached 5 min (`TOGGLE_CACHE_TTL_SECONDS`, default 300; the local demo uses a few seconds); on refresh
error serve the stale cache; with no cache at all -> treat as `disabled` (fail safe, not fail open).
Deploy-time hard switch: env `SENDING_HARD_DISABLED` - anything except the literal `false` disables
sending.

## 8. Function environment

| Var                                                                                                           | Used by    | AWS                       | Local                                          |
| ------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------- | ---------------------------------------------- |
| `TABLE_SUBSCRIPTIONS`, `TABLE_PENDING_DIGEST`, `TABLE_DELIVERIES`, `TABLE_DELIVERY_LOG`, `TABLE_SUPPRESSIONS` | as needed  | table names               | `subscriptions`, ...                           |
| `EMAIL_QUEUE_URL`                                                                                             | notifiers  | queue URL                 | LocalStack URL                                 |
| `FROM_ADDRESS`                                                                                                | processor  | `notifications@<domain>`  | `notifications@example.test`                   |
| `SES_CONFIGURATION_SET`                                                                                       | processor  | set name                  | unset                                          |
| `MAIL_TRANSPORT`                                                                                              | processor  | `ses`                     | `smtp` (Mailpit)                               |
| `SMTP_HOST` / `SMTP_PORT`                                                                                     | processor  | -                         | `mailpit` / `1025`                             |
| `SSM_PREFIX`                                                                                                  | processor  | `/<prefix>/email/`        | same (LocalStack SSM)                          |
| `SENDING_HARD_DISABLED`                                                                                       | processor  | `false` (deploy flag)     | `false`                                        |
| `APP_BASE_URL`                                                                                                | notifiers  | product URL               | `http://localhost:8080`                        |
| `SEGMENTS`                                                                                                    | digest     | `16`                      | `16`                                           |
| `DIGEST_WINDOW_START_HOUR` / `DIGEST_WINDOW_END_HOUR`                                                         | digest     | `6` / `10` (default)      | same                                           |
| `DIGEST_CONCURRENCY`                                                                                          | digest     | `8` (default)             | same                                           |
| `TOGGLE_CACHE_TTL_SECONDS`                                                                                    | processor  | `300` (default)           | `5` in the demo profile                        |
| `CHECK_SES_SUPPRESSION_LIST`                                                                                  | processor  | unset (= check, ses only) | n/a (smtp)                                     |
| `INTAKE_QUEUE_URL`, `EVENT_BUS_NAME`                                                                          | local CLIs | -                         | resolved from `intake` / `app-events` if unset |
| `AWS_ENDPOINT_URL`                                                                                            | all        | unset                     | `http://localstack:4566`                       |
| `POWERTOOLS_SERVICE_NAME`, `POWERTOOLS_METRICS_NAMESPACE=EmailDelivery`, `LOG_LEVEL`                          | all        | set by infra              | set by compose                                 |

Digest handler event (from EventBridge Scheduler): `{ "segment": 7 }`. Segments are hash-based, not
time-zone based, and a user is only mailed while their local time is inside the window, so the
scheduler must invoke **every segment at least once per window hour** (hourly per segment, staggered
minutes). Re-runs are safe: one deliveryId per user per local date. After queueing a digest the
notifier deletes the included `pending-digest` items; a run returns
`{ segment, users, due, queued, alreadyDelivered, nothingPending, failed, remaining, invalidSubscriptions }`,
stops starting users with < 30 s left (`remaining` > 0), and throws if any user failed so the run
is alarmed (scheduler retries are off per ADR 0006; a manual re-run is safe).

Feedback handler: EventBridge rule on `source = aws.ses` and `detail.eventType` in `Bounce`,
`Complaint`, `Delivery`, `Reject` (the handler keys off `detail.eventType`, not `detail-type`).
Permanent bounces and complaints upsert `suppressions`; transient bounces are only logged; the
delivery-log row uses the `deliveryId` message tag (`detail.mail.tags.deliveryId[0]`). A suppression
write failure throws (EventBridge retries); a delivery-log failure does not.

## 9. Metrics (namespace `EmailDelivery`)

`MessagesReceived`, `EmailsSent`, `EmailsSkipped` (+ dimension-free variants per reason in logs),
`InvalidMessages`, `DuplicatesSuppressed`, `ClaimContention`, `TransientFailures`,
`PermanentFailures`, `AmbiguousDeliveries`, `MarkFailures`, `Suppressed`, `NotificationsQueued`,
`DigestUsers`, `FeedbackEvents`, `Bounces`, `Complaints`.

## 10. Local stack (docker compose) and ports

| Service          | Port                       | Notes                                                                                                        |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| localstack       | 4566                       | sqs, dynamodb, ssm, events; init hook creates queues (+DLQs), tables, SSM params                             |
| mailpit          | 8025 (UI/API), 1025 (SMTP) | receives every e-mail locally                                                                                |
| worker-immediate | -                          | polls the intake queue, runs `notifier-immediate`                                                            |
| worker-processor | -                          | polls the email queue, runs `processor`                                                                      |
| jobs             | -                          | profile `jobs`: `seed`, `publish` (requests), `digest -- --segment N`, `feedback -- --type bounce --email x` |

Local resource names (created by `deploy/localstack/init-aws.sh`, which the compose owner writes):
queues `intake`, `intake-dlq`, `email`, `email-dlq` (maxReceiveCount 3); EventBridge bus `app-events`
with rule `notification-requested` -> `intake` (input path `$.detail`); tables exactly as in section 4
(names without prefix, same keys, GSIs and TTL attributes); SSM `/local/email/send-emails = enabled`,
`/local/email/record-deliveries = enabled` (`SSM_PREFIX=/local/email/`). The `publish` CLI uses
`PutEvents` on `app-events`; `--direct` sends straight to the intake queue.

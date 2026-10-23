# 3. Running locally

LocalStack stands in for EventBridge, SQS, DynamoDB and SSM; Mailpit stands in for SES and shows every
e-mail in a browser. The two workers long-poll the queues and call the same handlers the Lambdas run.

## Prerequisites

| Tool                | Version | Needed for                   |
| ------------------- | ------- | ---------------------------- |
| Docker + Compose v2 | 24+     | the stack and the smoke test |
| Node.js             | 22      | tests, CDK                   |
| GNU make            | any     | shortcuts (optional)         |

## Start, seed, check

```bash
make up      # localstack (queues, bus, tables, toggles), mailpit, worker-immediate, worker-processor
make seed    # 40 users across 12 time zones; every 10th address pre-suppressed
make smoke   # see below
```

| URL                   | What                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------ |
| http://localhost:8025 | Mailpit - every e-mail the processor sent; `X-Tag-deliveryId` header shows the delivery id |
| http://localhost:4566 | LocalStack                                                                                 |

## What `make smoke` proves

1. 100 published requests - with duplicates and invalid ones - produce exactly one e-mail per
   delivery id, and the number of e-mails equals the number of `SENT` deliveries.
2. No e-mail reaches a suppressed address; invalid requests are dropped, not retried (both DLQs empty).
3. Markup in request data arrives escaped in the HTML.
4. Publishing the same 100 requests again sends **nothing**.
5. The digest sends one digest per user; running it again the same day sends **nothing**.
6. With `send-emails = disabled`, nothing is sent and every message is recorded as `SKIPPED(disabled)`.
7. A permanent bounce adds the address to the suppression list - as a hash, never the address.

## Doing things by hand

```bash
docker compose run --rm jobs publish -- --count 20             # through the EventBridge bus
docker compose run --rm jobs publish -- --count 20 --direct    # straight to the intake queue
docker compose run --rm jobs digest -- --segment 3 --ignore-window
docker compose run --rm jobs feedback -- --type complaint --email user-007@example.test
docker compose exec localstack awslocal dynamodb scan --table-name deliveries --max-items 5
make down
```

## Without Docker

```bash
npm ci && npm test                     # unit tests: claim state machine, classification, budget, redaction, ...
AWS_ENDPOINT_URL=http://localhost:4566 npm run test:int   # against a running LocalStack
cd infra && npm ci && npm test         # CDK assertions, IAM, cycles, cdk-nag
```

## Troubleshooting

| Symptom                           | Cause / fix                                                                                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everything is `SKIPPED(disabled)` | `SENDING_HARD_DISABLED` must be the literal `false` (it is in compose) and `/local/email/send-emails` must be `enabled`. After changing the SSM value, restart `worker-processor` or wait 5 minutes. |
| No digest arrives                 | Outside the users' local morning window; use `--ignore-window` locally.                                                                                                                              |
| Workers never healthy             | They wait for LocalStack's init hook - `docker compose logs localstack`.                                                                                                                             |

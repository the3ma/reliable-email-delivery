# Delivery Console - local demo UI contract

A **local-only** demo: a browser UI and a thin API over the local stack (LocalStack + Mailpit). It is
never deployed and is not part of the AWS stack - in AWS the same information lives in DynamoDB,
CloudWatch and SES. It exists to _show_ the delivery guarantees working.

```
browser -> web (nginx :8080) -> /api/* -> console-api (:3001) -> LocalStack (:4566), Mailpit (:8025)
```

## Layout

| Path                   | Owner                                | Notes                                                                                                                                                                                    |
| ---------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/console-api` | root workspace (`@mail/console-api`) | Hono on Node 22; reuses `@mail/core` (schemas, dedup, redaction, toggles) and the functions' CLIs' logic (seed / publish / digest / feedback) as importable functions - never shells out |
| `web/`                 | own package + lockfile               | Vite + React 19 + TypeScript strict, MSW mock mode, Vitest + Testing Library; Dockerfile with `build` and `serve` (nginx) stages, nginx proxies `/api` to `console-api`                  |

## Rules

- Local only: the API refuses to start unless `AWS_ENDPOINT_URL` is set (it must never point at a
  real account). No auth (localhost demo), CORS limited to the web origin.
- **Privacy stays on**: the console shows addresses **masked** (`u***@example.test`) everywhere
  except the Mailbox, which is the local inbox of fake `example.test` users. Suppression entries
  show only the hash.
- E-mail HTML is rendered only inside `<iframe sandbox="" srcdoc=...>` (no scripts, no same-origin,
  no forms, no top navigation) and with remote images blocked by a CSP in the srcdoc.
- JSON everywhere; errors `{ "error": { "code", "message" } }`; list endpoints `{ "items": [], "nextCursor": null|string }`.

## API (`/api/v1`, console-api)

| Method | Path                   | Body / query                                                | Response                                                                                                                                                                                                                                                                                   |
| ------ | ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/health`              | -                                                           | `{ status, checks: { localstack, mailpit } }`                                                                                                                                                                                                                                              |
| GET    | `/overview`            | -                                                           | `{ counts: { SENT, SKIPPED, RELEASED, CLAIMED, FAILED_PERMANENT, AMBIGUOUS }, skippedByReason: {..}, queues: { intake, intakeDlq, email, emailDlq }: {visible, inFlight}, toggles: { sendEmails, recordDeliveries }, mail: { total }, suppressions: { total }, subscriptions: { total } }` |
| GET    | `/scenarios`           | -                                                           | `[{ id, title, description, expected }]` (see below)                                                                                                                                                                                                                                       |
| POST   | `/scenarios/{id}/run`  | `{}`                                                        | `{ runId, startedAt, published, notes }` - returns immediately; effects show up as the workers process                                                                                                                                                                                     |
| GET    | `/deliveries`          | `status`, `category`, `kind`, `limit` (1-200, 50), `cursor` | items: `{ deliveryId, status, reason?, category, kind, userId, toMasked, attempts, updatedAt }` newest first                                                                                                                                                                               |
| GET    | `/deliveries/{id}`     | -                                                           | the item + `events: [{ at, event, details }]` from `delivery-log` (redacted) + `mailId?` (Mailpit id when found by the `X-Tag-deliveryId` header)                                                                                                                                          |
| GET    | `/suppressions`        | -                                                           | items: `{ emailHash, reason, source, createdAt, lastEventAt }`                                                                                                                                                                                                                             |
| POST   | `/feedback`            | `{ type: bounce                                             | complaint                                                                                                                                                                                                                                                                                  | delivery, email, transient?: boolean }`                                                                             | `{ ok, suppressed }` - builds the real SES EventBridge event and invokes the feedback handler |
| GET    | `/toggles`             | -                                                           | `{ sendEmails: enabled                                                                                                                                                                                                                                                                     | disabled, recordDeliveries }`                                                                                       |
| PUT    | `/toggles/send-emails` | `{ value: enabled                                           | disabled }`                                                                                                                                                                                                                                                                                | `{ value, note: "the processor picks it up within its cache TTL (5 min); the demo worker is restarted/refreshed" }` |
| POST   | `/digest/run`          | `{ segment?: 0-15, all?: true, ignoreWindow?: true }`       | `{ users, queued, alreadyDelivered, parts }`                                                                                                                                                                                                                                               |
| POST   | `/reset`               | `{}`                                                        | clears deliveries, delivery-log, pending-digest, suppressions (except seeded), Mailpit, re-seeds subscriptions                                                                                                                                                                             |
| GET    | `/mail`                | `limit`, `cursor`                                           | items: `{ id, to, subject, createdAt, deliveryId?, category?, size }` (Mailpit API proxy)                                                                                                                                                                                                  |
| GET    | `/mail/{id}`           | -                                                           | `{ id, to, from, subject, createdAt, text, html, headers: { name: [values] }, deliveryId? }`                                                                                                                                                                                               |

Kill-switch note: the local `worker-processor` should pick up a toggle change quickly for the demo.
console-api may expose `POST /workers/refresh-toggles` only if the functions offer a supported way
(e.g. a `TOGGLE_CACHE_TTL_SECONDS` env, set to `5` in the demo compose profile); never patch the
cache from outside.

## Scenarios

| id                | What it does                                                                                    | Expected                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `burst`           | 50 valid immediate requests for 20 users                                                        | ~50 e-mails, one per delivery id                                         |
| `duplicate-storm` | the same 10 notifications published 12 times each, concurrently (the old system's "118 x" case) | exactly 10 e-mails; ~110 duplicates dropped (`DuplicatesSuppressed`)     |
| `invalid`         | 5 malformed requests (bad JSON, unknown category, bad address, missing field, oversized)        | 0 e-mails, 0 retries, DLQs stay empty                                    |
| `suppressed`      | notifications to pre-suppressed users                                                           | 0 e-mails; `SKIPPED(suppressed)`                                         |
| `digest`          | queue digest items for 10 users, run all segments with `ignoreWindow`                           | one digest per user; a second run sends 0                                |
| `big-digest`      | 400 large items for one user, run the digest                                                    | the digest arrives in parts `part i/n`, each its own delivery id         |
| `kill-switch`     | set `send-emails = disabled`, publish 10, set it back                                           | 0 e-mails, 10 `SKIPPED(disabled)`                                        |
| `bounce`          | send to one user, simulate a permanent bounce, send again                                       | first e-mail delivered, address suppressed, second `SKIPPED(suppressed)` |

## Web pages

| Route           | Content                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/` Dashboard   | status counters, skipped-by-reason, queue + DLQ depths, kill switch (toggle with confirm), totals; polls `/overview` (2 s, back-off when hidden)                               |
| `/scenarios`    | a card per scenario: title, what it does, expected outcome, Run button, then a live "observed" panel (counters before/after) so the visitor can compare expected vs observed   |
| `/deliveries`   | filterable table (status chips, category, kind), pagination; row -> drawer with the state timeline (CLAIMED -> SENT ...), SES events, attempts, link to the e-mail             |
| `/mailbox`      | the local e-mail viewer: list (to, subject, time, category badge) + preview pane with tabs HTML (sandboxed iframe) / Text / Headers; `deliveryId` header links to its delivery |
| `/suppressions` | table (hash shortened with copy button, reason, source, dates) + "simulate bounce / complaint" form (fake `example.test` address only)                                         |

Quality bar: TypeScript strict, no `any`; accessible (landmarks, labelled controls, keyboard
navigation, focus management in the drawer, `aria-live` for scenario progress, colour is never the
only signal - status chips have text); empty, loading and error states for every view; responsive down
to 375 px; no external fonts/CDNs.

## Compose (profile `demo`)

| Service     | Port | Notes                                                                                                                                                       |
| ----------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| console-api | 3001 | image built from `Dockerfile.functions` target or its own stage; env as the workers + `MAILPIT_URL=http://mailpit:8025`, `WEB_ORIGIN=http://localhost:8080` |
| web         | 8080 | nginx serving the built SPA, `/api` -> `console-api:3001`                                                                                                   |

`make demo` = `make up` + seed + `docker compose --profile demo up -d --build --wait`.

## console-api implementation notes

Behaviour beyond (or more precise than) the table above. The web client may rely on these.

- **Status codes**: `POST /scenarios/{id}/run` answers `202`. While a background scenario
  (`kill-switch`, `bounce`) is still running, another run or `/reset` gets `409 run_in_progress`
  (both change shared state). `/health` answers `503` with `status: "degraded"` when a check is down.
  Validation errors are `400` with code `invalid_request` / `invalid_query` / `invalid_json` /
  `invalid_cursor`; unknown ids `404 not_found`; anything else `500 internal` (details only in the
  console-api log).
- **Extra endpoint**: `GET /scenarios/runs/{runId}` ->
  `{ runId, scenario, startedAt, finishedAt?, status: running|done|failed, published, notes[] }`.
  The last 50 runs are kept in memory. Background scenarios append to `notes` as they progress.
- **Deliveries**: the processor now stores masked, descriptive fields with the claim or skip
  (`userId`, `category`, `kind`, `toMasked`; CONTRACT section 4). On an item written before that,
  `category` / `kind` / `userId` / `toMasked` are `null`. `reason` is present only when set. A
  digest has `category: "digest"`. `cursor` is opaque. `mailId` is found by matching the stored
  SMTP Message-ID against Mailpit.
- **`/digest/run`** also returns `due`, `nothingPending`, `remaining`, `failed` and `failures[]`.
  `users` is the number of subscriptions scanned. `parts` is the number of e-mails queued, counting
  every part of a split digest.
- **`/reset`** also purges the four queues (`intake`, `intake-dlq`, `email`, `email-dlq`). It answers
  `{ cleared: { deliveries, deliveryLog, pendingDigest, suppressions, subscriptions, mail: true, queues: true }, seeded: { users, suppressed, segments } }`.
- **`/mail`**: `to` is the comma-joined recipient list (unmasked: the local inbox of fake users) and
  `cursor` is an offset. `deliveryId` / `category` come from the `X-Tag-deliveryId` /
  `X-Tag-category` headers (matched case-insensitively; Mailpit canonicalises header names).
- **`/feedback`** accepts only `@example.test` addresses.
- **Kill switch**: there is no `/workers/refresh-toggles`. The workers support
  `TOGGLE_CACHE_TTL_SECONDS` (default 300). The demo profile should set it, e.g. `5`, on
  `worker-processor` **and** on `console-api`; the console only reads it to know how long to wait.
  The `PUT /toggles/send-emails` note states that TTL.
- **Scenarios**:
  - Seed users: `burst`, `duplicate-storm`, `invalid`, `suppressed` and `kill-switch` use the seed users and
    upsert the ones they need, so no prior `seed` is required. `suppressed` needs the seeded
    suppressions (`/reset` re-creates them).
  - Run-specific users: `digest`, `big-digest` and `bounce` create users of their own (`u-dg-<run>-<n>`,
    `u-big-<run>-1`, `u-bounce-<run>-1`), so they can be re-run without a reset.
  - `digest` and `big-digest` write `pending-digest` items like `notifier-immediate` does, then run the
    digest logic in-process with `ignoreWindow` (`digest`: all segments, so anyone else with pending
    items is mailed too). `published` = e-mails queued.
  - `kill-switch`: sets `disabled`, waits TTL + 2 s, publishes 10, waits until all 10 have a
    delivery record (max `SCENARIO_WAIT_SECONDS`, default 120), then sets `enabled` again. The toggle
    is restored even if a step fails.
  - `bounce`: sends one, waits for `SENT`, injects a permanent bounce (tagged with the delivery id),
    then sends again.
  - `invalid`: 3 bodies go to `intake` (bad JSON, unknown category, missing `entityId`) and 2 to
    `email` (invalid recipient address, html over 200 KiB).

### console-api environment

| Var                                                                                      | Default                                      | Notes                                                        |
| ---------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `AWS_ENDPOINT_URL`                                                                       | **required**                                 | refuses to start without it, or with an `amazonaws.com` host |
| `PORT` / `HOST`                                                                          | `3001` / `0.0.0.0`                           |                                                              |
| `MAILPIT_URL`                                                                            | `http://localhost:8025`                      | compose: `http://mailpit:8025`                               |
| `WEB_ORIGIN`                                                                             | `http://localhost:8080`                      | the only CORS origin                                         |
| `APP_BASE_URL`, `TABLE_*`, `SSM_PREFIX`, `SEGMENTS`, `DIGEST_WINDOW_*`, `EVENT_BUS_NAME` | contract local values                        | same as the workers                                          |
| `INTAKE_QUEUE_NAME`, `INTAKE_DLQ_NAME`, `EMAIL_QUEUE_NAME`, `EMAIL_DLQ_NAME`             | `intake`, `intake-dlq`, `email`, `email-dlq` |                                                              |
| `SEED_USERS` / `SEED_SUPPRESS_EVERY`                                                     | `40` / `10`                                  | used by `/reset` and the scenarios                           |
| `TOGGLE_CACHE_TTL_SECONDS`                                                               | `300`                                        | set it to the workers' value                                 |
| `SCENARIO_WAIT_SECONDS`                                                                  | `120`                                        | background scenario timeout                                  |

Run it: `npm run console-api` (tsx) or `docker run <functions image> console-api`.

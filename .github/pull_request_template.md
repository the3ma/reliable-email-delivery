## What & why

<!-- One or two sentences. Link the issue. -->

## Changes

-

## Checklist

- [ ] `npm test` (functions) and `npm test --prefix infra` pass locally
- [ ] `make up && make seed && make smoke` passes if a handler, a template or the local stack changed
- [ ] A new failure path is classified (permanent / transient / after-send) and tested
- [ ] No recipient address or body text can reach a log line or metric
- [ ] `docs/CONTRACT.md` updated if a message, table, state, toggle or env var changed
- [ ] An ADR added or updated for a design decision

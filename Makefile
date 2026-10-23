.PHONY: help up seed smoke logs down test test-int test-infra

help:          ## list targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*## /\t/'

up:            ## build and start localstack, mailpit and both workers
	docker compose up -d --build --wait localstack mailpit worker-immediate worker-processor

seed:          ## 40 subscriptions across 12 time zones; every 10th address pre-suppressed
	docker compose run --rm jobs seed

smoke:         ## publish -> dedup -> suppression -> digest -> kill switch -> bounce feedback
	./scripts/smoke.sh

logs:          ## follow both workers
	docker compose logs -f worker-immediate worker-processor

down:          ## stop and delete containers and volumes
	docker compose --profile jobs down -v

test:          ## lint, typecheck, format, unit tests, build (functions)
	npm ci && npm run lint && npm run typecheck && npm run format:check && npm test && npm run build

test-int:      ## DynamoDB integration tests; needs AWS_ENDPOINT_URL (LocalStack)
	npm run test:int

test-infra:    ## CDK lint, tests (cycles, IAM, cdk-nag), synth
	cd infra && npm ci && npm run lint && npm test && npm run synth -- -q

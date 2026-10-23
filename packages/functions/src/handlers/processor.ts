import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { createProcessor } from '../app/processor.js';
import { createObservability, traced } from '../lib/observability.js';
import { requireEnv } from '../lib/env.js';
import { accountSuppressionList, awsAdapters, mailTransport, toggleCache } from '../lib/wiring.js';

const { log, telemetry, tracer } = createObservability('processor');
let processor: ReturnType<typeof createProcessor> | undefined;

// Built on first use so importing the module (tests, bundling) never needs AWS config; then
// reused across warm invocations, which keeps the toggle cache alive.
function instance(): ReturnType<typeof createProcessor> {
  if (!processor) {
    const aws = awsAdapters(tracer);
    processor = createProcessor({
      deliveries: aws.deliveries(),
      deliveryLog: aws.deliveryLog(),
      suppressions: aws.suppressions(),
      accountSuppressions: accountSuppressionList(tracer),
      transport: mailTransport(tracer),
      toggles: toggleCache(tracer, log),
      log,
      telemetry,
      fromAddress: requireEnv('FROM_ADDRESS'),
      hardDisabled: process.env.SENDING_HARD_DISABLED,
    });
  }
  return processor;
}

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  log.logger.addContext(context);
  return traced(tracer, 'processor', () => instance()(event, context));
}

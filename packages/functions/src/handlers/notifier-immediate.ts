import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { createNotifierImmediate } from '../app/notifier-immediate.js';
import { SqsEmailQueue } from '../lib/email-queue.js';
import { requireEnv } from '../lib/env.js';
import { createObservability, traced } from '../lib/observability.js';
import { awsAdapters } from '../lib/wiring.js';

const { log, telemetry, tracer } = createObservability('notifier-immediate');
let notifier: ReturnType<typeof createNotifierImmediate> | undefined;

function instance(): ReturnType<typeof createNotifierImmediate> {
  if (!notifier) {
    const aws = awsAdapters(tracer);
    notifier = createNotifierImmediate({
      subscriptions: aws.subscriptions(),
      pendingDigest: aws.pendingDigest(),
      deliveries: aws.deliveries(),
      emailQueue: new SqsEmailQueue(aws.sqs(), requireEnv('EMAIL_QUEUE_URL')),
      log,
      telemetry,
      appBaseUrl: requireEnv('APP_BASE_URL'),
      minRemainingMs: 10_000,
    });
  }
  return notifier;
}

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  log.logger.addContext(context);
  return traced(tracer, 'notifier-immediate', () => instance()(event, context));
}

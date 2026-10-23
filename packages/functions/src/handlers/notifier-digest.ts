import { parseDigestWindow } from '@mail/core';
import type { Context } from 'aws-lambda';
import { createNotifierDigest } from '../app/notifier-digest.js';
import type { DigestRunResult } from '../app/notifier-digest.js';
import { SqsEmailQueue } from '../lib/email-queue.js';
import { intEnv, optionalEnv, requireEnv } from '../lib/env.js';
import { createObservability, traced } from '../lib/observability.js';
import { awsAdapters } from '../lib/wiring.js';

const { log, telemetry, tracer } = createObservability('notifier-digest');
let notifier: ReturnType<typeof createNotifierDigest> | undefined;

function instance(): ReturnType<typeof createNotifierDigest> {
  if (!notifier) {
    const aws = awsAdapters(tracer);
    notifier = createNotifierDigest({
      subscriptions: aws.subscriptions(),
      pendingDigest: aws.pendingDigest(),
      deliveries: aws.deliveries(),
      emailQueue: new SqsEmailQueue(aws.sqs(), requireEnv('EMAIL_QUEUE_URL')),
      log,
      telemetry,
      appBaseUrl: requireEnv('APP_BASE_URL'),
      segments: intEnv('SEGMENTS', 16),
      window: parseDigestWindow(
        optionalEnv('DIGEST_WINDOW_START_HOUR'),
        optionalEnv('DIGEST_WINDOW_END_HOUR'),
      ),
      concurrency: intEnv('DIGEST_CONCURRENCY', 8),
    });
  }
  return notifier;
}

/** Event from EventBridge Scheduler: `{ "segment": 7 }`. */
export async function handler(event: unknown, context: Context): Promise<DigestRunResult> {
  log.logger.addContext(context);
  return traced(tracer, 'notifier-digest', () => instance()(event, context));
}

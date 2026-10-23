import type { Context } from 'aws-lambda';
import { createFeedback } from '../app/feedback.js';
import type { FeedbackResult } from '../app/feedback.js';
import { createObservability, traced } from '../lib/observability.js';
import { awsAdapters } from '../lib/wiring.js';

const { log, telemetry, tracer } = createObservability('feedback');
let feedback: ReturnType<typeof createFeedback> | undefined;

function instance(): ReturnType<typeof createFeedback> {
  if (!feedback) {
    const aws = awsAdapters(tracer);
    feedback = createFeedback({
      suppressions: aws.suppressions(),
      deliveryLog: aws.deliveryLog(),
      log,
      telemetry,
    });
  }
  return feedback;
}

/** EventBridge events from SES (source aws.ses): Bounce, Complaint, Delivery, Reject. */
export async function handler(
  event: unknown,
  context: Context,
): Promise<FeedbackResult | undefined> {
  log.logger.addContext(context);
  return traced(tracer, 'feedback', () => instance()(event));
}

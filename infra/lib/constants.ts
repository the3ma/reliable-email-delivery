import { Duration } from 'aws-cdk-lib';

/** Function timeouts. Queue visibility timeouts are derived from these, so they live in one place. */
export const TIMEOUTS = {
  notifierImmediate: Duration.seconds(60),
  // A segment run stops before its own deadline and is idempotent; 5 minutes keeps a run small.
  notifierDigest: Duration.minutes(5),
  // The handler stops picking up records with < 30 s left; 10 sequential sends fit comfortably.
  processor: Duration.seconds(60),
  feedback: Duration.seconds(30),
} as const;

export const BATCH_SIZE = 10;
export const MAX_BATCHING_WINDOW = Duration.seconds(5);
export const MAX_RECEIVE_COUNT = 3;
// Email messages are capped at 500 KiB (CONTRACT section 6): a batch of 10 must fit the 6 MB Lambda payload.
export const EMAIL_MAX_MESSAGE_BYTES = 512 * 1024;
export const RETENTION = Duration.days(14);

/**
 * AWS guidance for SQS event sources: visibility timeout >= 6 x function timeout, plus the batching
 * window. It also keeps a crashed worker's message invisible past its 120 s claim lease, so the retry
 * sees an expired lease (AMBIGUOUS) instead of a live one.
 */
export function visibilityFor(functionTimeout: Duration): Duration {
  return Duration.seconds(functionTimeout.toSeconds() * 6 + MAX_BATCHING_WINDOW.toSeconds());
}

export const METRICS_NAMESPACE = 'EmailDelivery';

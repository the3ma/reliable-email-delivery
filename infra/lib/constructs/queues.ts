import { type aws_kms as kms, aws_sqs as sqs, Duration, type RemovalPolicy } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { MAX_RECEIVE_COUNT, RETENTION } from '../constants';

export interface QueuePair {
  readonly queue: sqs.Queue;
  readonly dlq: sqs.Queue;
}

export interface EncryptedQueueProps {
  readonly name: string;
  readonly key: kms.IKey;
  readonly removalPolicy: RemovalPolicy;
  readonly visibilityTimeout?: Duration;
  readonly deadLetterQueue?: sqs.IQueue;
  readonly maxMessageSizeBytes?: number;
}

/** An SQS queue encrypted with the stack key, TLS-only, 14-day retention. */
export function encryptedQueue(
  scope: Construct,
  id: string,
  props: EncryptedQueueProps,
): sqs.Queue {
  const queue = new sqs.Queue(scope, id, {
    queueName: props.name,
    encryption: sqs.QueueEncryption.KMS,
    encryptionMasterKey: props.key,
    // Re-use a data key for 5 minutes: bounds KMS calls (cost + throttling) at high message rates.
    dataKeyReuse: Duration.minutes(5),
    enforceSSL: true,
    retentionPeriod: RETENTION,
    ...(props.visibilityTimeout ? { visibilityTimeout: props.visibilityTimeout } : {}),
    ...(props.maxMessageSizeBytes ? { maxMessageSizeBytes: props.maxMessageSizeBytes } : {}),
    ...(props.deadLetterQueue
      ? { deadLetterQueue: { queue: props.deadLetterQueue, maxReceiveCount: MAX_RECEIVE_COUNT } }
      : {}),
  });
  queue.applyRemovalPolicy(props.removalPolicy);
  return queue;
}

/** A work queue with its own DLQ after MAX_RECEIVE_COUNT receives. */
export function queueWithDlq(
  scope: Construct,
  id: string,
  props: Omit<EncryptedQueueProps, 'deadLetterQueue'> & { readonly visibilityTimeout: Duration },
): QueuePair {
  const dlq = encryptedQueue(scope, `${id}Dlq`, {
    name: `${props.name}-dlq`,
    key: props.key,
    removalPolicy: props.removalPolicy,
  });
  const queue = encryptedQueue(scope, id, { ...props, deadLetterQueue: dlq });
  return { queue, dlq };
}

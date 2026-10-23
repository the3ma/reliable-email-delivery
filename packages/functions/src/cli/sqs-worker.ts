import { DeleteMessageBatchCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import { scrubAddresses } from '@mail/core';
import type {
  Context,
  SQSBatchResponse,
  SQSEvent,
  SQSMessageAttributes,
  SQSRecord,
} from 'aws-lambda';
import { localContext } from './local.js';

export type SqsHandler = (event: SQSEvent, context: Context) => Promise<SQSBatchResponse>;

export function queueArn(queueUrl: string, region: string): string {
  const [account = '000000000000', name = 'queue'] = new URL(queueUrl).pathname
    .split('/')
    .filter(Boolean)
    .slice(-2);
  return `arn:aws:sqs:${region}:${account}:${name}`;
}

/** Shapes ReceiveMessage output exactly like the Lambda SQS event source does. */
export function toSqsEvent(messages: readonly Message[], arn: string, region: string): SQSEvent {
  const Records: SQSRecord[] = messages.map((message) => {
    const system = message.Attributes ?? {};
    const messageAttributes: SQSMessageAttributes = {};
    for (const [name, value] of Object.entries(message.MessageAttributes ?? {})) {
      messageAttributes[name] = {
        dataType: value.DataType ?? 'String',
        stringListValues: [],
        binaryListValues: [],
        ...(value.StringValue === undefined ? {} : { stringValue: value.StringValue }),
      };
    }
    return {
      messageId: message.MessageId ?? '',
      receiptHandle: message.ReceiptHandle ?? '',
      body: message.Body ?? '',
      attributes: {
        ApproximateReceiveCount: system.ApproximateReceiveCount ?? '1',
        SentTimestamp: system.SentTimestamp ?? String(Date.now()),
        SenderId: system.SenderId ?? 'local',
        ApproximateFirstReceiveTimestamp:
          system.ApproximateFirstReceiveTimestamp ?? String(Date.now()),
      },
      messageAttributes,
      md5OfBody: message.MD5OfBody ?? '',
      eventSource: 'aws:sqs',
      eventSourceARN: arn,
      awsRegion: region,
    };
  });
  return { Records };
}

export interface WorkerOptions {
  sqs: SQSClient;
  queueUrl: string;
  functionName: string;
  /** Per-batch budget, like a Lambda timeout. */
  timeoutMs: number;
  handler: SqsHandler;
  region: string;
}

function note(message: string, extra: Record<string, unknown> = {}): void {
  console.error(
    JSON.stringify({ level: 'INFO', worker: true, message: scrubAddresses(message), ...extra }),
  );
}

/**
 * Lambda's SQS poller, locally: long-poll, invoke, delete only the successes, leave failures to
 * reappear after the visibility timeout. A thrown handler error fails the whole batch, as in Lambda.
 * SIGTERM/SIGINT abort the poll, let the in-flight batch finish, then exit.
 */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const abort = new AbortController();
  const stopped = (): boolean => abort.signal.aborted;
  const stop = (signal: string): void => {
    if (stopped()) return;
    note(`received ${signal}; finishing the current batch`);
    abort.abort();
  };
  process.once('SIGTERM', () => {
    stop('SIGTERM');
  });
  process.once('SIGINT', () => {
    stop('SIGINT');
  });

  const arn = queueArn(options.queueUrl, options.region);
  note(`polling ${arn}`, { functionName: options.functionName });

  while (!stopped()) {
    let messages: Message[];
    try {
      const received = await options.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: options.queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
          MessageSystemAttributeNames: ['All'],
          MessageAttributeNames: ['All'],
        }),
        { abortSignal: abort.signal },
      );
      messages = received.Messages ?? [];
    } catch (error) {
      if (stopped()) break;
      note('receive failed; backing off', {
        error: error instanceof Error ? scrubAddresses(error.message) : 'unknown',
      });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    if (messages.length === 0) continue;

    let response: SQSBatchResponse;
    try {
      response = await options.handler(
        toSqsEvent(messages, arn, options.region),
        localContext(options.functionName, options.timeoutMs),
      );
    } catch (error) {
      note('handler threw; the whole batch will be redelivered', {
        error: error instanceof Error ? scrubAddresses(error.message) : 'unknown',
      });
      continue;
    }

    const failed = new Set(response.batchItemFailures.map((failure) => failure.itemIdentifier));
    const done = messages.filter((message) => message.MessageId && !failed.has(message.MessageId));
    if (done.length > 0) {
      const result = await options.sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: options.queueUrl,
          Entries: done.map((message, index) => ({
            Id: String(index),
            ReceiptHandle: message.ReceiptHandle ?? '',
          })),
        }),
      );
      if (result.Failed && result.Failed.length > 0)
        note('some deletes failed; those messages will be redelivered', {
          failed: result.Failed.length,
        });
    }
    note('batch done', { received: messages.length, deleted: done.length, retry: failed.size });
  }
  note('worker stopped');
}

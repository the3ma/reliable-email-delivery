import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { EmailMessage } from '@mail/core';

export interface EmailQueue {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Standard queue: no MessageDeduplicationId. Duplicates are harmless because the processor's
 * claim on deliveryId is the guarantee; the id rides along as an attribute for tracing.
 */
export class SqsEmailQueue implements EmailQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
        MessageAttributes: {
          deliveryId: { DataType: 'String', StringValue: message.deliveryId },
          kind: { DataType: 'String', StringValue: message.kind },
        },
      }),
    );
  }
}

export class MemoryEmailQueue implements EmailQueue {
  readonly messages: EmailMessage[] = [];
  failWith: Error | undefined;

  send(message: EmailMessage): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.messages.push(message);
    return Promise.resolve();
  }
}

import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
} from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { QueueAdmin, QueueDepth, QueueKey } from '../ports.js';

export class SqsQueueAdmin implements QueueAdmin {
  private readonly urls = new Map<QueueKey, string>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly names: Readonly<Record<QueueKey, string>>,
  ) {}

  private async url(key: QueueKey): Promise<string> {
    const cached = this.urls.get(key);
    if (cached) return cached;
    const result = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.names[key] }));
    if (!result.QueueUrl) throw new Error(`queue ${this.names[key]} not found`);
    this.urls.set(key, result.QueueUrl);
    return result.QueueUrl;
  }

  async depths(): Promise<Record<QueueKey, QueueDepth>> {
    const keys = Object.keys(this.names) as QueueKey[];
    const entries = await Promise.all(
      keys.map(async (key) => {
        const result = await this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: await this.url(key),
            AttributeNames: [
              'ApproximateNumberOfMessages',
              'ApproximateNumberOfMessagesNotVisible',
            ],
          }),
        );
        const depth: QueueDepth = {
          visible: Number(result.Attributes?.ApproximateNumberOfMessages ?? 0),
          inFlight: Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
        };
        return [key, depth] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<QueueKey, QueueDepth>;
  }

  async purgeAll(): Promise<void> {
    for (const key of Object.keys(this.names) as QueueKey[]) {
      await this.sqs.send(new PurgeQueueCommand({ QueueUrl: await this.url(key) }));
    }
  }
}

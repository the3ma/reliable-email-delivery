import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetQueueUrlCommand, SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';

export type QueueName = 'intake' | 'email';

/** How notification requests (and, for demos, raw bodies) enter the pipeline. */
export interface Publisher {
  /** The product's path: EventBridge `notification.requested` -> rule -> intake queue. */
  putEvents(details: readonly unknown[]): Promise<{ published: number; failed: number }>;
  /** Straight onto a queue, body as given (lets demos send malformed JSON). */
  sendRaw(
    queue: QueueName,
    bodies: readonly string[],
  ): Promise<{ published: number; failed: number }>;
}

export interface AwsPublisherOptions {
  eventBusName: string;
  queueNames: Readonly<Record<QueueName, string>>;
  /** Explicit URLs win over a GetQueueUrl lookup by name. */
  queueUrls?: Partial<Record<QueueName, string>>;
  eventBridge?: EventBridgeClient;
  sqs?: SQSClient;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export class AwsPublisher implements Publisher {
  private readonly eventBridge: EventBridgeClient;
  private readonly sqs: SQSClient;
  private readonly urls = new Map<QueueName, Promise<string>>();

  constructor(private readonly options: AwsPublisherOptions) {
    this.eventBridge = options.eventBridge ?? new EventBridgeClient({});
    this.sqs = options.sqs ?? new SQSClient({});
  }

  queueUrl(queue: QueueName): Promise<string> {
    let url = this.urls.get(queue);
    if (!url) {
      const explicit = this.options.queueUrls?.[queue];
      url = explicit
        ? Promise.resolve(explicit)
        : this.sqs
            .send(new GetQueueUrlCommand({ QueueName: this.options.queueNames[queue] }))
            .then((result) => {
              if (!result.QueueUrl)
                throw new Error(`queue ${this.options.queueNames[queue]} not found`);
              return result.QueueUrl;
            });
      // A failed lookup must not be cached forever.
      url.catch(() => this.urls.delete(queue));
      this.urls.set(queue, url);
    }
    return url;
  }

  /** Batches of 10 are sent concurrently, so a storm really arrives at once. */
  async putEvents(details: readonly unknown[]): Promise<{ published: number; failed: number }> {
    const results = await Promise.all(
      chunks(details, 10).map((batch) =>
        this.eventBridge.send(
          new PutEventsCommand({
            Entries: batch.map((detail) => ({
              EventBusName: this.options.eventBusName,
              Source: 'app.notifications',
              DetailType: 'notification.requested',
              Detail: JSON.stringify(detail),
            })),
          }),
        ),
      ),
    );
    const failed = results.reduce((sum, result) => sum + (result.FailedEntryCount ?? 0), 0);
    return { published: details.length - failed, failed };
  }

  async sendRaw(
    queue: QueueName,
    bodies: readonly string[],
  ): Promise<{ published: number; failed: number }> {
    const queueUrl = await this.queueUrl(queue);
    const results = await Promise.all(
      chunks(bodies, 10).map((batch) =>
        this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: batch.map((body, index) => ({ Id: String(index), MessageBody: body })),
          }),
        ),
      ),
    );
    const failed = results.reduce((sum, result) => sum + (result.Failed?.length ?? 0), 0);
    return { published: bodies.length - failed, failed };
  }
}

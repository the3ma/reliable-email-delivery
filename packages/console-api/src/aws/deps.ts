import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SSMClient } from '@aws-sdk/client-ssm';
import { Logger } from '@aws-lambda-powertools/logger';
import {
  DynamoDeliveriesStore,
  DynamoDeliveryLog,
  DynamoPendingDigest,
  DynamoSubscriptions,
  DynamoSuppressions,
  documentClient,
} from '@mail/core';
import { AwsPublisher, SafeLog, SqsEmailQueue } from '@mail/functions';
import type { EmailMessage } from '@mail/core';
import type { EmailQueue } from '@mail/functions';
import type { ConsoleConfig } from '../config.js';
import type { ConsoleDeps } from '../ports.js';
import {
  DynamoDeliveriesAdmin,
  DynamoDeliveryLogAdmin,
  DynamoSuppressionsAdmin,
  DynamoTableAdmin,
} from './dynamo-admin.js';
import { MailpitClient } from './mailpit.js';
import { SqsQueueAdmin } from './queues.js';
import { SsmTogglesAdmin } from './toggles.js';

/** The email queue URL is looked up by name on first use, so startup never blocks on LocalStack. */
class LazyEmailQueue implements EmailQueue {
  private queue: Promise<SqsEmailQueue> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly url: () => Promise<string>,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    this.queue ??= this.url().then((url) => new SqsEmailQueue(this.sqs, url));
    this.queue.catch(() => (this.queue = undefined));
    await (await this.queue).send(message);
  }
}

export function awsDeps(config: ConsoleConfig): ConsoleDeps {
  const ddb = documentClient();
  const sqs = new SQSClient({});
  const t = config.tables;
  const publisher = new AwsPublisher({
    eventBusName: config.eventBusName,
    queueNames: { intake: config.queues.intake, email: config.queues.email },
    sqs,
  });
  return {
    config,
    deliveries: new DynamoDeliveriesStore(ddb, t.deliveries),
    deliveriesAdmin: new DynamoDeliveriesAdmin(ddb, t.deliveries),
    deliveryLog: new DynamoDeliveryLog(ddb, t.deliveryLog),
    deliveryLogAdmin: new DynamoDeliveryLogAdmin(ddb, t.deliveryLog),
    suppressions: new DynamoSuppressions(ddb, t.suppressions),
    suppressionsAdmin: new DynamoSuppressionsAdmin(ddb, t.suppressions),
    subscriptions: new DynamoSubscriptions(ddb, t.subscriptions),
    subscriptionsAdmin: new DynamoTableAdmin(ddb, t.subscriptions, ['userId']),
    pendingDigest: new DynamoPendingDigest(ddb, t.pendingDigest),
    pendingDigestAdmin: new DynamoTableAdmin(ddb, t.pendingDigest, ['userId', 'sk']),
    queues: new SqsQueueAdmin(sqs, config.queues),
    toggles: new SsmTogglesAdmin(new SSMClient({}), config.ssmPrefix),
    mail: new MailpitClient(config.mailpitUrl),
    publisher,
    emailQueue: new LazyEmailQueue(sqs, () => publisher.queueUrl('email')),
    localstackPing: async () => {
      try {
        await ddb.send(new ListTablesCommand({ Limit: 1 }));
        return true;
      } catch {
        return false;
      }
    },
    log: new SafeLog(
      new Logger({ serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? 'console-api' }),
    ),
  };
}

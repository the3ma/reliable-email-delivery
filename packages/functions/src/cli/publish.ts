import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { applyLocalDefaults, intArg, main, parseArgs, resolveQueueUrl } from './local.js';
import { generateRequests } from './publish-data.js';

await main(async () => {
  const args = parseArgs(process.argv.slice(2), {
    count: 'string',
    users: 'string',
    seed: 'string',
    direct: 'boolean',
  });
  applyLocalDefaults('publish');
  const requests = generateRequests({
    count: intArg(args, 'count', 100),
    users: Math.max(1, intArg(args, 'users', 40)),
    seed: intArg(args, 'seed', 42),
  });

  let failed = 0;
  if (args.direct) {
    const sqs = new SQSClient({});
    const queueUrl = await resolveQueueUrl(sqs, 'INTAKE_QUEUE_URL', 'intake');
    for (let i = 0; i < requests.length; i += 10) {
      const batch = requests.slice(i, i + 10);
      const result = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: batch.map((request, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(request.detail),
          })),
        }),
      );
      failed += result.Failed?.length ?? 0;
    }
  } else {
    const events = new EventBridgeClient({});
    const bus = process.env.EVENT_BUS_NAME ?? 'app-events';
    for (let i = 0; i < requests.length; i += 10) {
      const batch = requests.slice(i, i + 10);
      const result = await events.send(
        new PutEventsCommand({
          Entries: batch.map((request) => ({
            EventBusName: bus,
            Source: 'app.notifications',
            DetailType: 'notification.requested',
            Detail: JSON.stringify(request.detail),
          })),
        }),
      );
      failed += result.FailedEntryCount ?? 0;
    }
  }

  const count = (kind: string): number =>
    requests.filter((request) => request.kind === kind).length;
  console.log(
    JSON.stringify({
      mode: args.direct ? 'sqs-direct' : 'eventbridge',
      published: requests.length - failed,
      failed,
      valid: count('valid'),
      duplicates: count('duplicate'),
      invalid: count('invalid'),
    }),
  );
  return failed === 0 ? 0 : 1;
});

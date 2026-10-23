import { SQSClient } from '@aws-sdk/client-sqs';
import { applyLocalDefaults, main, resolveQueueUrl } from './local.js';
import { runWorker } from './sqs-worker.js';

applyLocalDefaults('notifier-immediate');

await main(async () => {
  const sqs = new SQSClient({});
  // The handler needs EMAIL_QUEUE_URL at first use; resolve it from the queue name if unset.
  process.env.EMAIL_QUEUE_URL = await resolveQueueUrl(sqs, 'EMAIL_QUEUE_URL', 'email');
  const { handler } = await import('../handlers/notifier-immediate.js');
  await runWorker({
    sqs,
    queueUrl: await resolveQueueUrl(sqs, 'INTAKE_QUEUE_URL', 'intake'),
    functionName: 'notifier-immediate',
    timeoutMs: 60_000,
    handler,
    region: process.env.AWS_REGION ?? 'us-east-1',
  });
  return 0;
});

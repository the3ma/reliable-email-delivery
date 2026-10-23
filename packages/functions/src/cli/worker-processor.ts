import { SQSClient } from '@aws-sdk/client-sqs';
import { applyLocalDefaults, main, resolveQueueUrl } from './local.js';
import { runWorker } from './sqs-worker.js';

// Defaults first: the handler module reads its configuration when it is imported.
applyLocalDefaults('processor');
const { handler } = await import('../handlers/processor.js');

await main(async () => {
  const sqs = new SQSClient({});
  await runWorker({
    sqs,
    queueUrl: await resolveQueueUrl(sqs, 'EMAIL_QUEUE_URL', 'email'),
    functionName: 'processor',
    timeoutMs: 60_000,
    handler,
    region: process.env.AWS_REGION ?? 'us-east-1',
  });
  return 0;
});

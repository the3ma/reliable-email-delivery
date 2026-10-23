import { AwsPublisher } from '../ops/publish.js';
import { applyLocalDefaults, intArg, main, parseArgs } from './local.js';
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
  const publisher = new AwsPublisher({
    eventBusName: process.env.EVENT_BUS_NAME ?? 'app-events',
    queueNames: { intake: 'intake', email: 'email' },
    queueUrls: {
      ...(process.env.INTAKE_QUEUE_URL ? { intake: process.env.INTAKE_QUEUE_URL } : {}),
      ...(process.env.EMAIL_QUEUE_URL ? { email: process.env.EMAIL_QUEUE_URL } : {}),
    },
  });
  const details = requests.map((request) => request.detail);
  const { published, failed } = args.direct
    ? await publisher.sendRaw(
        'intake',
        details.map((detail) => JSON.stringify(detail)),
      )
    : await publisher.putEvents(details);

  const count = (kind: string): number =>
    requests.filter((request) => request.kind === kind).length;
  console.log(
    JSON.stringify({
      mode: args.direct ? 'sqs-direct' : 'eventbridge',
      published,
      failed,
      valid: count('valid'),
      duplicates: count('duplicate'),
      invalid: count('invalid'),
    }),
  );
  return failed === 0 ? 0 : 1;
});

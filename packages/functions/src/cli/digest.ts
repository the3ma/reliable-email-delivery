import { applyLocalDefaults, intArg, localContext, main, parseArgs } from './local.js';

const USAGE = 'usage: digest -- (--segment N | --all) [--ignore-window]';

await main(async () => {
  const args = parseArgs(process.argv.slice(2), {
    segment: 'string',
    all: 'boolean',
    'ignore-window': 'boolean',
  });
  if ((args.segment === undefined) === (args.all === undefined)) throw new Error(USAGE);

  applyLocalDefaults('notifier-digest');
  if (args['ignore-window']) {
    // Local demos: treat every user as being in their morning window right now.
    process.env.DIGEST_WINDOW_START_HOUR = '0';
    process.env.DIGEST_WINDOW_END_HOUR = '24';
  }
  const { SQSClient } = await import('@aws-sdk/client-sqs');
  const { resolveQueueUrl } = await import('./local.js');
  process.env.EMAIL_QUEUE_URL = await resolveQueueUrl(
    new SQSClient({}),
    'EMAIL_QUEUE_URL',
    'email',
  );
  const { handler } = await import('../handlers/notifier-digest.js');

  const segments = Number(process.env.SEGMENTS ?? '16');
  const targets = args.all
    ? Array.from({ length: segments }, (_, i) => i)
    : [intArg(args, 'segment', 0)];
  let failures = 0;
  for (const segment of targets) {
    try {
      const result = await handler({ segment }, localContext('notifier-digest', 5 * 60_000));
      console.log(JSON.stringify(result));
    } catch (error) {
      failures += 1;
      console.error(
        `segment ${segment} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failures === 0 ? 0 : 1;
});

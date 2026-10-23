import { SQSClient } from '@aws-sdk/client-sqs';
import { runDigestSegments } from '../ops/digest.js';
import {
  applyLocalDefaults,
  intArg,
  localContext,
  main,
  parseArgs,
  resolveQueueUrl,
} from './local.js';

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
  process.env.EMAIL_QUEUE_URL = await resolveQueueUrl(
    new SQSClient({}),
    'EMAIL_QUEUE_URL',
    'email',
  );
  // Dynamic only for our own handler module: it reads the environment set above when first used.
  const { handler } = await import('../handlers/notifier-digest.js');

  const segments = Number(process.env.SEGMENTS ?? '16');
  const targets = args.all
    ? Array.from({ length: segments }, (_, i) => i)
    : [intArg(args, 'segment', 0)];
  const summary = await runDigestSegments(
    (event) => handler(event, localContext('notifier-digest', 5 * 60_000)),
    targets,
  );
  for (const result of summary.results) console.log(JSON.stringify(result));
  for (const failure of summary.failures) {
    console.error(`segment ${String(failure.segment)} failed: ${failure.message}`);
  }
  return summary.failures.length === 0 ? 0 : 1;
});

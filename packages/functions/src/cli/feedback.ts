import { maskEmail } from '@mail/core';
import { FEEDBACK_TYPES, simulateFeedback } from '../ops/feedback.js';
import { applyLocalDefaults, localContext, main, parseArgs, stringArg } from './local.js';

const USAGE =
  'usage: feedback -- --type bounce|complaint|delivery|reject --email <address> [--delivery-id <id>] [--transient]';

await main(async () => {
  const args = parseArgs(process.argv.slice(2), {
    type: 'string',
    email: 'string',
    'delivery-id': 'string',
    transient: 'boolean',
  });
  const type = stringArg(args, 'type') ?? '';
  const email = stringArg(args, 'email');
  if (!FEEDBACK_TYPES[type] || !email) throw new Error(USAGE);

  applyLocalDefaults('feedback');
  // Dynamic only for our own handler module: it reads the environment set above when first used.
  const { handler } = await import('../handlers/feedback.js');
  const result = await simulateFeedback(
    (event) => handler(event, localContext('feedback', 30_000)),
    {
      type,
      email,
      deliveryId: stringArg(args, 'delivery-id'),
      transient: args.transient === true,
    },
  );
  console.log(JSON.stringify({ email: maskEmail(email), ...result }));
  return 0;
});

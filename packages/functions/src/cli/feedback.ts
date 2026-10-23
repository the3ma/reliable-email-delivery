import { maskEmail } from '@mail/core';
import { buildSesEvent } from '../app/ses-events.js';
import type { SesEventType } from '../app/ses-events.js';
import { applyLocalDefaults, localContext, main, parseArgs, stringArg } from './local.js';

const TYPES: Readonly<Record<string, SesEventType>> = {
  bounce: 'Bounce',
  complaint: 'Complaint',
  delivery: 'Delivery',
  reject: 'Reject',
};

const USAGE =
  'usage: feedback -- --type bounce|complaint|delivery|reject --email <address> [--delivery-id <id>] [--transient]';

await main(async () => {
  const args = parseArgs(process.argv.slice(2), {
    type: 'string',
    email: 'string',
    'delivery-id': 'string',
    transient: 'boolean',
  });
  const type = TYPES[stringArg(args, 'type') ?? ''];
  const email = stringArg(args, 'email');
  if (!type || !email) throw new Error(USAGE);

  applyLocalDefaults('feedback');
  const { handler } = await import('../handlers/feedback.js');
  const event = buildSesEvent({
    type,
    email,
    deliveryId: stringArg(args, 'delivery-id'),
    bounceType: args.transient ? 'Transient' : 'Permanent',
  });
  const result = await handler(event, localContext('feedback', 30_000));
  console.log(JSON.stringify({ email: maskEmail(email), ...result }));
  return 0;
});

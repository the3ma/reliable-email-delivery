import { DynamoSubscriptions, DynamoSuppressions, documentClient, emailHash } from '@mail/core';
import { applyLocalDefaults, intArg, main, parseArgs } from './local.js';
import { seedSubscription } from './seed-data.js';

await main(async () => {
  const args = parseArgs(process.argv.slice(2), { users: 'string', 'suppress-every': 'string' });
  applyLocalDefaults('seed');
  const users = intArg(args, 'users', 40);
  const suppressEvery = intArg(args, 'suppress-every', 10);
  const segments = Number(process.env.SEGMENTS ?? '16');

  const ddb = documentClient();
  const subscriptions = new DynamoSubscriptions(
    ddb,
    process.env.TABLE_SUBSCRIPTIONS ?? 'subscriptions',
  );
  const suppressions = new DynamoSuppressions(
    ddb,
    process.env.TABLE_SUPPRESSIONS ?? 'suppressions',
  );

  let suppressed = 0;
  const perSegment = new Map<number, number>();
  for (let i = 1; i <= users; i += 1) {
    const subscription = seedSubscription(i, segments);
    await subscriptions.put(subscription);
    perSegment.set(subscription.segment, (perSegment.get(subscription.segment) ?? 0) + 1);
    if (suppressEvery > 0 && i % suppressEvery === 0) {
      await suppressions.upsert({
        emailHash: emailHash(subscription.email),
        reason: 'manual',
        source: 'seed',
        at: new Date(),
      });
      suppressed += 1;
    }
  }
  console.log(
    JSON.stringify({
      users,
      suppressed,
      segments: Object.fromEntries([...perSegment.entries()].sort(([a], [b]) => a - b)),
    }),
  );
  return 0;
});

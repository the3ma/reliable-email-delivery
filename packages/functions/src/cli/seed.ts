import { DynamoSubscriptions, DynamoSuppressions, documentClient } from '@mail/core';
import { seedUsers } from '../ops/seed.js';
import { applyLocalDefaults, intArg, main, parseArgs } from './local.js';

await main(async () => {
  const args = parseArgs(process.argv.slice(2), { users: 'string', 'suppress-every': 'string' });
  applyLocalDefaults('seed');
  const ddb = documentClient();
  const result = await seedUsers({
    subscriptions: new DynamoSubscriptions(ddb, process.env.TABLE_SUBSCRIPTIONS ?? 'subscriptions'),
    suppressions: new DynamoSuppressions(ddb, process.env.TABLE_SUPPRESSIONS ?? 'suppressions'),
    users: intArg(args, 'users', 40),
    suppressEvery: intArg(args, 'suppress-every', 10),
    segments: Number(process.env.SEGMENTS ?? '16'),
  });
  console.log(JSON.stringify(result));
  return 0;
});

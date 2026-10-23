import { emailHash } from '@mail/core';
import type { SubscriptionsRepository, SuppressionStore } from '@mail/core';
import { seedSubscription } from '../cli/seed-data.js';

export interface SeedOptions {
  subscriptions: SubscriptionsRepository;
  suppressions: SuppressionStore;
  users: number;
  /** Every n-th user is pre-suppressed (reason `manual`, source `seed`); 0 disables. */
  suppressEvery: number;
  segments: number;
  now?: Date;
}

export interface SeedResult {
  users: number;
  suppressed: number;
  segments: Record<string, number>;
}

/** Idempotent: re-seeding overwrites the same users and refreshes the same suppressions. */
export async function seedUsers(options: SeedOptions): Promise<SeedResult> {
  let suppressed = 0;
  const perSegment = new Map<number, number>();
  for (let i = 1; i <= options.users; i += 1) {
    const subscription = seedSubscription(i, options.segments);
    await options.subscriptions.put(subscription);
    perSegment.set(subscription.segment, (perSegment.get(subscription.segment) ?? 0) + 1);
    if (options.suppressEvery > 0 && i % options.suppressEvery === 0) {
      await options.suppressions.upsert({
        emailHash: emailHash(subscription.email),
        reason: 'manual',
        source: 'seed',
        at: options.now ?? new Date(),
      });
      suppressed += 1;
    }
  }
  return {
    users: options.users,
    suppressed,
    segments: Object.fromEntries(
      [...perSegment.entries()].sort(([a], [b]) => a - b).map(([k, v]) => [String(k), v]),
    ),
  };
}

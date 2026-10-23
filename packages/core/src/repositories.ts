import type { PendingDigestItem, Subscription } from './schemas.js';

/** Rows that fail schema validation are counted, not silently dropped, so callers can report them. */
export interface Listing<T> {
  items: T[];
  invalid: number;
}

export interface SubscriptionsRepository {
  get(userId: string): Promise<Subscription | undefined>;
  /** All subscriptions of one segment, via the `by-segment` GSI. */
  listBySegment(segment: number): Promise<Listing<Subscription>>;
  put(subscription: Subscription): Promise<void>;
}

export interface PendingDigestRepository {
  /** Idempotent per (userId, sk): a redelivered request does not create a second item. */
  add(item: PendingDigestItem): Promise<void>;
  listForUser(userId: string): Promise<Listing<PendingDigestItem>>;
  remove(userId: string, sortKeys: readonly string[]): Promise<void>;
}

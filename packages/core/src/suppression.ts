import { emailHash } from './dedup.js';

export type SuppressionReason = 'bounce_permanent' | 'complaint' | 'manual';

export interface SuppressionRecord {
  emailHash: string;
  reason: SuppressionReason;
  source: string;
  createdAt: string;
  lastEventAt: string;
}

export interface SuppressionUpsert {
  emailHash: string;
  reason: SuppressionReason;
  source: string;
  at: Date;
}

export interface SuppressionStore {
  get(emailHash: string): Promise<SuppressionRecord | undefined>;
  /** Insert or refresh; `createdAt` is kept from the first event. */
  upsert(entry: SuppressionUpsert): Promise<void>;
}

export interface AccountSuppressionList {
  isSuppressed(address: string): Promise<boolean>;
}

export type SuppressionCheck =
  | { suppressed: false }
  | { suppressed: true; source: 'table'; reason: SuppressionReason }
  | { suppressed: true; source: 'account' };

/**
 * Table first (cheap, ours), then the optional SES account list. Lookup errors propagate: the
 * caller treats them as transient rather than mailing an address it could not check.
 */
export async function checkSuppression(
  address: string,
  deps: { store: SuppressionStore; accountList?: AccountSuppressionList | undefined },
): Promise<SuppressionCheck> {
  const record = await deps.store.get(emailHash(address));
  if (record) return { suppressed: true, source: 'table', reason: record.reason };
  if (deps.accountList && (await deps.accountList.isSuppressed(address))) {
    return { suppressed: true, source: 'account' };
  }
  return { suppressed: false };
}

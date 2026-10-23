export const DeliveryStatus = {
  CLAIMED: 'CLAIMED',
  SENT: 'SENT',
  FAILED_PERMANENT: 'FAILED_PERMANENT',
  RELEASED: 'RELEASED',
  AMBIGUOUS: 'AMBIGUOUS',
  SKIPPED: 'SKIPPED',
} as const;
export type DeliveryStatus = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

/** States that end the delivery: a later message with the same deliveryId is a duplicate. */
export const TERMINAL_STATUSES: readonly DeliveryStatus[] = [
  DeliveryStatus.SENT,
  DeliveryStatus.SKIPPED,
  DeliveryStatus.FAILED_PERMANENT,
  DeliveryStatus.AMBIGUOUS,
];

export const LEASE_SECONDS = 120;
export const DELIVERY_RETENTION_DAYS = 400;

/** Descriptive, non-secret fields written with the claim or skip so a delivery can be listed. */
export interface DeliveryMeta {
  userId: string;
  category: string;
  kind: 'immediate' | 'digest';
  /** Masked recipient (`a***@example.test`), never the address itself. */
  toMasked: string;
}

export interface DeliveryRecord extends Partial<DeliveryMeta> {
  deliveryId: string;
  status: DeliveryStatus;
  attempts: number;
  leaseUntil?: number;
  leaseOwner?: string;
  sesMessageId?: string;
  reason?: string;
  updatedAt: string;
  expiresAt: number;
}

export interface ClaimRequest {
  deliveryId: string;
  owner: string;
  leaseUntil: number;
  now: Date;
  expiresAt: number;
  meta?: DeliveryMeta;
}

export interface LeaseRef {
  deliveryId: string;
  leaseOwner: string | undefined;
  leaseUntil: number | undefined;
  now: Date;
}

export type Completion =
  | { status: typeof DeliveryStatus.SENT; sesMessageId: string }
  | { status: typeof DeliveryStatus.FAILED_PERMANENT; reason: string }
  | { status: typeof DeliveryStatus.RELEASED; reason: string };

/**
 * Port over the `deliveries` table. Every write is conditional; a `false` return means the
 * condition failed (someone else changed the item), never "an error happened" - errors throw.
 */
export interface DeliveriesStore {
  /** (absent | RELEASED) -> CLAIMED(owner, leaseUntil). Keeps `attempts`. */
  claim(request: ClaimRequest): Promise<boolean>;
  get(deliveryId: string): Promise<DeliveryRecord | undefined>;
  /** CLAIMED -> AMBIGUOUS, only while the lease we observed is still the one stored. */
  markAmbiguous(lease: LeaseRef): Promise<boolean>;
  /** CLAIMED(owner) -> SENT | FAILED_PERMANENT | RELEASED (attempts + 1). */
  complete(deliveryId: string, owner: string, now: Date, completion: Completion): Promise<boolean>;
  /** (absent | RELEASED) -> SKIPPED(reason). */
  skip(
    deliveryId: string,
    reason: string,
    now: Date,
    expiresAt: number,
    meta?: DeliveryMeta,
  ): Promise<boolean>;
}

export type ClaimOutcome =
  | { kind: 'claimed'; leaseUntil: number }
  | { kind: 'duplicate'; status: DeliveryStatus }
  | { kind: 'contended' }
  | { kind: 'ambiguous' };

export function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function retentionExpiry(now: Date, days: number = DELIVERY_RETENTION_DAYS): number {
  return epochSeconds(now) + days * 24 * 60 * 60;
}

export interface ClaimOptions {
  deliveryId: string;
  /** The invocation's request id: only the claimant may mark the outcome. */
  owner: string;
  now: Date;
  leaseSeconds?: number;
  meta?: DeliveryMeta;
}

/**
 * Contract section 5. At-most-once: a CLAIMED item whose lease expired may or may not have been
 * sent, so it becomes AMBIGUOUS (alarmed) and is never retried automatically.
 */
export async function claimDelivery(
  store: DeliveriesStore,
  options: ClaimOptions,
): Promise<ClaimOutcome> {
  const nowSeconds = epochSeconds(options.now);
  const leaseUntil = nowSeconds + (options.leaseSeconds ?? LEASE_SECONDS);
  const claimed = await store.claim({
    deliveryId: options.deliveryId,
    owner: options.owner,
    leaseUntil,
    now: options.now,
    expiresAt: retentionExpiry(options.now),
    ...(options.meta ? { meta: options.meta } : {}),
  });
  if (claimed) return { kind: 'claimed', leaseUntil };

  const existing = await store.get(options.deliveryId);
  // Gone (TTL) or RELEASED again between our two calls: a retry resolves it either way.
  if (!existing || existing.status === DeliveryStatus.RELEASED) return { kind: 'contended' };
  if (TERMINAL_STATUSES.includes(existing.status)) {
    return { kind: 'duplicate', status: existing.status };
  }

  const leaseLive = existing.leaseUntil !== undefined && existing.leaseUntil >= nowSeconds;
  if (leaseLive) return { kind: 'contended' };

  const marked = await store.markAmbiguous({
    deliveryId: options.deliveryId,
    leaseOwner: existing.leaseOwner,
    leaseUntil: existing.leaseUntil,
    now: options.now,
  });
  return marked ? { kind: 'ambiguous' } : { kind: 'contended' };
}

import { DeliveryStatus } from '../deliveries.js';
import type {
  ClaimRequest,
  Completion,
  DeliveryMeta,
  DeliveriesStore,
  DeliveryRecord,
  LeaseRef,
} from '../deliveries.js';
import type { DeliveryLogItem, DeliveryLogWriter } from '../delivery-log.js';
import type { Listing, PendingDigestRepository, SubscriptionsRepository } from '../repositories.js';
import type { PendingDigestItem, Subscription } from '../schemas.js';
import type {
  AccountSuppressionList,
  SuppressionRecord,
  SuppressionStore,
  SuppressionUpsert,
} from '../suppression.js';
import type { ToggleSource } from '../toggles.js';
import type { MailTransport, OutgoingEmail, SendResult } from '../transport.js';

function metaOf(record: DeliveryRecord | undefined): Partial<DeliveryMeta> {
  if (!record) return {};
  const meta: Partial<DeliveryMeta> = {};
  if (record.userId !== undefined) meta.userId = record.userId;
  if (record.category !== undefined) meta.category = record.category;
  if (record.kind !== undefined) meta.kind = record.kind;
  if (record.toMasked !== undefined) meta.toMasked = record.toMasked;
  return meta;
}

/** In-memory twin of DynamoDeliveriesStore with identical conditional semantics. */
export class InMemoryDeliveriesStore implements DeliveriesStore {
  readonly items = new Map<string, DeliveryRecord>();
  failNext: Partial<Record<'claim' | 'get' | 'complete' | 'skip' | 'markAmbiguous', Error>> = {};

  private maybeFail(operation: keyof InMemoryDeliveriesStore['failNext']): void {
    const error = this.failNext[operation];
    if (error) {
      this.failNext = { ...this.failNext, [operation]: undefined };
      throw error;
    }
  }

  claim(request: ClaimRequest): Promise<boolean> {
    this.maybeFail('claim');
    const existing = this.items.get(request.deliveryId);
    if (existing && existing.status !== DeliveryStatus.RELEASED) return Promise.resolve(false);
    const record: DeliveryRecord = {
      deliveryId: request.deliveryId,
      status: DeliveryStatus.CLAIMED,
      attempts: existing?.attempts ?? 0,
      leaseOwner: request.owner,
      leaseUntil: request.leaseUntil,
      updatedAt: request.now.toISOString(),
      expiresAt: request.expiresAt,
      ...metaOf(existing),
      ...(request.meta ?? {}),
    };
    this.items.set(request.deliveryId, record);
    return Promise.resolve(true);
  }

  get(deliveryId: string): Promise<DeliveryRecord | undefined> {
    this.maybeFail('get');
    const record = this.items.get(deliveryId);
    return Promise.resolve(record ? { ...record } : undefined);
  }

  markAmbiguous(lease: LeaseRef): Promise<boolean> {
    this.maybeFail('markAmbiguous');
    const existing = this.items.get(lease.deliveryId);
    if (
      existing?.status !== DeliveryStatus.CLAIMED ||
      existing.leaseOwner !== lease.leaseOwner ||
      existing.leaseUntil !== lease.leaseUntil
    ) {
      return Promise.resolve(false);
    }
    this.items.set(lease.deliveryId, {
      ...existing,
      status: DeliveryStatus.AMBIGUOUS,
      reason: 'lease_expired',
      updatedAt: lease.now.toISOString(),
    });
    return Promise.resolve(true);
  }

  complete(deliveryId: string, owner: string, now: Date, completion: Completion): Promise<boolean> {
    this.maybeFail('complete');
    const existing = this.items.get(deliveryId);
    if (existing?.status !== DeliveryStatus.CLAIMED || existing.leaseOwner !== owner) {
      return Promise.resolve(false);
    }
    const next: DeliveryRecord = {
      ...existing,
      status: completion.status,
      updatedAt: now.toISOString(),
    };
    delete next.leaseUntil;
    if (completion.status === DeliveryStatus.SENT) next.sesMessageId = completion.sesMessageId;
    else next.reason = completion.reason;
    if (completion.status === DeliveryStatus.RELEASED) {
      next.attempts = existing.attempts + 1;
      delete next.leaseOwner;
    }
    this.items.set(deliveryId, next);
    return Promise.resolve(true);
  }

  skip(
    deliveryId: string,
    reason: string,
    now: Date,
    expiresAt: number,
    meta?: DeliveryMeta,
  ): Promise<boolean> {
    this.maybeFail('skip');
    const existing = this.items.get(deliveryId);
    if (existing && existing.status !== DeliveryStatus.RELEASED) return Promise.resolve(false);
    this.items.set(deliveryId, {
      deliveryId,
      status: DeliveryStatus.SKIPPED,
      attempts: existing?.attempts ?? 0,
      reason,
      updatedAt: now.toISOString(),
      expiresAt,
      ...metaOf(existing),
      ...(meta ?? {}),
    });
    return Promise.resolve(true);
  }
}

export class InMemoryDeliveryLog implements DeliveryLogWriter {
  readonly items: DeliveryLogItem[] = [];
  failWith: Error | undefined;

  put(item: DeliveryLogItem): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.items.push(item);
    return Promise.resolve();
  }

  events(deliveryId?: string): string[] {
    return this.items
      .filter((item) => deliveryId === undefined || item.deliveryId === deliveryId)
      .map((item) => item.event);
  }
}

export class InMemorySuppressions implements SuppressionStore {
  readonly items = new Map<string, SuppressionRecord>();
  failWith: Error | undefined;

  get(emailHash: string): Promise<SuppressionRecord | undefined> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.items.get(emailHash));
  }

  upsert(entry: SuppressionUpsert): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    const at = entry.at.toISOString();
    const existing = this.items.get(entry.emailHash);
    this.items.set(entry.emailHash, {
      emailHash: entry.emailHash,
      reason: entry.reason,
      source: entry.source,
      createdAt: existing?.createdAt ?? at,
      lastEventAt: at,
    });
    return Promise.resolve();
  }
}

export class InMemoryAccountSuppressionList implements AccountSuppressionList {
  constructor(readonly addresses = new Set<string>()) {}

  isSuppressed(address: string): Promise<boolean> {
    return Promise.resolve(this.addresses.has(address.toLowerCase()));
  }
}

export class InMemorySubscriptions implements SubscriptionsRepository {
  readonly items = new Map<string, Subscription>();
  invalidRows = 0;

  get(userId: string): Promise<Subscription | undefined> {
    return Promise.resolve(this.items.get(userId));
  }

  listBySegment(segment: number): Promise<Listing<Subscription>> {
    const items = [...this.items.values()]
      .filter((s) => s.segment === segment)
      .sort((a, b) => a.userId.localeCompare(b.userId));
    return Promise.resolve({ items, invalid: this.invalidRows });
  }

  put(subscription: Subscription): Promise<void> {
    this.items.set(subscription.userId, subscription);
    return Promise.resolve();
  }
}

export class InMemoryPendingDigest implements PendingDigestRepository {
  readonly items = new Map<string, PendingDigestItem>();

  add(item: PendingDigestItem): Promise<void> {
    const key = `${item.userId}|${item.sk}`;
    if (!this.items.has(key)) this.items.set(key, item);
    return Promise.resolve();
  }

  listForUser(userId: string): Promise<Listing<PendingDigestItem>> {
    const items = [...this.items.values()]
      .filter((item) => item.userId === userId)
      .sort((a, b) => a.sk.localeCompare(b.sk));
    return Promise.resolve({ items, invalid: 0 });
  }

  remove(userId: string, sortKeys: readonly string[]): Promise<void> {
    for (const sk of sortKeys) this.items.delete(`${userId}|${sk}`);
    return Promise.resolve();
  }
}

export class StaticToggleSource implements ToggleSource {
  calls = 0;
  failWith: Error | undefined;

  constructor(public values: Record<string, string>) {}

  fetch(): Promise<Record<string, string>> {
    this.calls += 1;
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve({ ...this.values });
  }
}

/** Records sends; queue errors with `failWith` to simulate SES/SMTP failures. */
export class MemoryTransport implements MailTransport {
  readonly name = 'memory' as const;
  readonly sent: OutgoingEmail[] = [];
  private readonly errors: unknown[] = [];
  private counter = 0;
  onSend: (() => void) | undefined;

  failWith(...errors: unknown[]): this {
    this.errors.push(...errors);
    return this;
  }

  send(email: OutgoingEmail): Promise<SendResult> {
    this.onSend?.();
    if (this.errors.length > 0) {
      const error = this.errors.shift();
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.sent.push(email);
    this.counter += 1;
    return Promise.resolve({ messageId: `msg-${this.counter}` });
  }
}

/** Builds an AWS SDK-shaped service error. */
export function awsError(name: string, httpStatusCode: number, message = name): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, {
    $metadata: { httpStatusCode },
    $fault: httpStatusCode >= 500 ? 'server' : 'client',
  });
  return error;
}

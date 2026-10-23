import { randomUUID } from 'node:crypto';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DeliveryStatus,
  DynamoDeliveriesStore,
  DynamoDeliveryLog,
  DynamoPendingDigest,
  DynamoSuppressions,
  ITEM_BUDGET_BYTES,
  buildLogItem,
  claimDelivery,
  epochSeconds,
  jsonBytes,
} from '../src/index.js';

/**
 * Real conditional-write semantics against LocalStack or DynamoDB Local. Each run creates its own
 * uniquely named tables, so it does not depend on (or disturb) the init hook's tables.
 */
const endpoint = process.env.AWS_ENDPOINT_URL;
if (!endpoint) {
  console.warn('[integration] AWS_ENDPOINT_URL is not set: skipping DynamoDB integration tests.');
}

const suffix = randomUUID().slice(0, 8);
const names = {
  deliveries: `it-deliveries-${suffix}`,
  log: `it-delivery-log-${suffix}`,
  pending: `it-pending-digest-${suffix}`,
  suppressions: `it-suppressions-${suffix}`,
};

function table(name: string, hash: string, range?: string): CreateTableCommandInput {
  return {
    TableName: name,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: hash, KeyType: 'HASH' },
      ...(range ? [{ AttributeName: range, KeyType: 'RANGE' as const }] : []),
    ],
    AttributeDefinitions: [
      { AttributeName: hash, AttributeType: 'S' },
      ...(range ? [{ AttributeName: range, AttributeType: 'S' as const }] : []),
    ],
  };
}

describe.skipIf(!endpoint)('DynamoDB adapters (integration)', () => {
  const raw = new DynamoDBClient({});
  const ddb = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const deliveries = new DynamoDeliveriesStore(ddb, names.deliveries);
  const T0 = new Date();

  beforeAll(async () => {
    const tables = [
      table(names.deliveries, 'deliveryId'),
      table(names.log, 'deliveryId', 'sk'),
      table(names.pending, 'userId', 'sk'),
      table(names.suppressions, 'emailHash'),
    ];
    for (const input of tables) {
      await raw.send(new CreateTableCommand(input));
      await waitUntilTableExists({ client: raw, maxWaitTime: 60 }, { TableName: input.TableName });
    }
  });

  afterAll(async () => {
    for (const name of Object.values(names)) {
      await raw.send(new DeleteTableCommand({ TableName: name })).catch(() => undefined);
    }
  });

  it('claim -> contention -> release -> reclaim (attempts kept) -> sent -> duplicate', async () => {
    const id = randomUUID().replaceAll('-', '').padEnd(64, '0');
    expect((await claimDelivery(deliveries, { deliveryId: id, owner: 'a', now: T0 })).kind).toBe(
      'claimed',
    );
    expect(await claimDelivery(deliveries, { deliveryId: id, owner: 'b', now: T0 })).toEqual({
      kind: 'contended',
    });
    expect(
      await deliveries.complete(id, 'b', T0, { status: DeliveryStatus.RELEASED, reason: 'x' }),
    ).toBe(false);
    expect(
      await deliveries.complete(id, 'a', T0, {
        status: DeliveryStatus.RELEASED,
        reason: 'Throttling',
      }),
    ).toBe(true);
    expect((await claimDelivery(deliveries, { deliveryId: id, owner: 'b', now: T0 })).kind).toBe(
      'claimed',
    );
    expect(await deliveries.get(id)).toMatchObject({
      status: 'CLAIMED',
      attempts: 1,
      leaseOwner: 'b',
    });
    expect(
      await deliveries.complete(id, 'b', T0, { status: DeliveryStatus.SENT, sesMessageId: 'm-1' }),
    ).toBe(true);
    expect(await claimDelivery(deliveries, { deliveryId: id, owner: 'c', now: T0 })).toEqual({
      kind: 'duplicate',
      status: 'SENT',
    });
    expect(await deliveries.skip(id, 'disabled', T0, 0)).toBe(false);
  });

  it('expired lease -> AMBIGUOUS (conditional on the lease)', async () => {
    const id = randomUUID().replaceAll('-', '').padEnd(64, '1');
    await claimDelivery(deliveries, { deliveryId: id, owner: 'a', now: T0, leaseSeconds: 1 });
    const later = new Date(T0.getTime() + 5_000);
    expect(await claimDelivery(deliveries, { deliveryId: id, owner: 'b', now: later })).toEqual({
      kind: 'ambiguous',
    });
    expect((await deliveries.get(id))?.status).toBe('AMBIGUOUS');
    expect(
      await deliveries.markAmbiguous({
        deliveryId: id,
        leaseOwner: 'a',
        leaseUntil: epochSeconds(T0) + 1,
        now: later,
      }),
    ).toBe(false);
  });

  it('a delivery-log item at the budget is accepted by DynamoDB', async () => {
    const item = buildLogItem({
      deliveryId: 'f'.repeat(64),
      event: 'failed',
      at: T0,
      details: { reason: 'r', trace: 'é'.repeat(300 * 1024) },
    });
    expect(jsonBytes(item)).toBeLessThanOrEqual(ITEM_BUDGET_BYTES);
    await expect(new DynamoDeliveryLog(ddb, names.log).put(item)).resolves.toBeUndefined();
  });

  it('pending-digest add is idempotent and remove deletes', async () => {
    const repo = new DynamoPendingDigest(ddb, names.pending);
    const item = {
      userId: 'u-int',
      sk: `2026-10-23T08:00:00Z#${randomUUID()}`,
      requestId: randomUUID(),
      category: 'comment_added' as const,
      entityId: 'doc-1',
      occurredAt: '2026-10-23T08:00:00Z',
      data: { subject: 'Doc' },
      segment: 1,
      expiresAt: epochSeconds(T0) + 60,
    };
    await repo.add(item);
    await repo.add({ ...item, data: { subject: 'changed' } });
    const listed = await repo.listForUser('u-int');
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.data).toEqual({ subject: 'Doc' });
    await repo.remove('u-int', [item.sk]);
    expect((await repo.listForUser('u-int')).items).toHaveLength(0);
  });

  it('suppression upsert keeps createdAt', async () => {
    const store = new DynamoSuppressions(ddb, names.suppressions);
    await store.upsert({
      emailHash: 'h1',
      reason: 'complaint',
      source: 's',
      at: new Date('2026-01-01T00:00:00Z'),
    });
    await store.upsert({
      emailHash: 'h1',
      reason: 'bounce_permanent',
      source: 's',
      at: new Date('2026-02-01T00:00:00Z'),
    });
    expect(await store.get('h1')).toMatchObject({
      reason: 'bounce_permanent',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastEventAt: '2026-02-01T00:00:00.000Z',
    });
  });
});

import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DeliveryStatus,
  DynamoDeliveriesStore,
  DynamoPendingDigest,
  DynamoSuppressions,
} from '../src/index.js';
import { awsError } from '../src/testing/index.js';

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

/** Records commands and replays canned responses; just enough of DocumentClient for the adapters. */
function fakeClient(responses: unknown[] = []) {
  const sent: Sent[] = [];
  const client = {
    send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      const next = responses.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? {});
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, sent };
}

const conditionFailed = () => awsError('ConditionalCheckFailedException', 400);
const ID = 'c'.repeat(64);
const NOW = new Date('2026-10-23T08:00:00Z');

describe('DynamoDeliveriesStore', () => {
  it('claim: conditional upsert exactly as the contract specifies', async () => {
    const { client, sent } = fakeClient();
    const store = new DynamoDeliveriesStore(client, 'deliveries');
    await expect(
      store.claim({ deliveryId: ID, owner: 'req-1', leaseUntil: 1000, now: NOW, expiresAt: 9 }),
    ).resolves.toBe(true);
    const input = sent[0]?.input;
    expect(sent[0]?.name).toBe('UpdateCommand');
    expect(input).toMatchObject({
      TableName: 'deliveries',
      Key: { deliveryId: ID },
      ConditionExpression: 'attribute_not_exists(deliveryId) OR #s = :released',
      ExpressionAttributeNames: { '#s': 'status' },
    });
    expect(input?.ExpressionAttributeValues).toMatchObject({
      ':claimed': 'CLAIMED',
      ':released': 'RELEASED',
      ':owner': 'req-1',
      ':lease': 1000,
    });
    expect(String(input?.UpdateExpression)).toContain('attempts = if_not_exists(attempts, :zero)');
  });

  it('claim: ConditionalCheckFailed -> false, other errors throw', async () => {
    const { client } = fakeClient([conditionFailed(), awsError('InternalServerError', 500)]);
    const store = new DynamoDeliveriesStore(client, 'deliveries');
    const request = { deliveryId: ID, owner: 'req-1', leaseUntil: 1, now: NOW, expiresAt: 1 };
    await expect(store.claim(request)).resolves.toBe(false);
    await expect(store.claim(request)).rejects.toThrow('InternalServerError');
  });

  it('mark SENT: conditional on CLAIMED and our lease owner', async () => {
    const { client, sent } = fakeClient([{}, conditionFailed()]);
    const store = new DynamoDeliveriesStore(client, 'deliveries');
    const completion = { status: DeliveryStatus.SENT, sesMessageId: 'm-1' } as const;
    await expect(store.complete(ID, 'req-1', NOW, completion)).resolves.toBe(true);
    await expect(store.complete(ID, 'req-1', NOW, completion)).resolves.toBe(false);
    expect(sent[0]?.input).toMatchObject({
      ConditionExpression: '#s = :claimed AND leaseOwner = :me',
    });
    expect(sent[0]?.input.ExpressionAttributeValues).toMatchObject({
      ':me': 'req-1',
      ':status': 'SENT',
      ':mid': 'm-1',
    });
  });

  it('release increments attempts and drops the lease', async () => {
    const { client, sent } = fakeClient();
    const store = new DynamoDeliveriesStore(client, 'deliveries');
    await store.complete(ID, 'req-1', NOW, {
      status: DeliveryStatus.RELEASED,
      reason: 'Throttling',
    });
    expect(String(sent[0]?.input.UpdateExpression)).toMatch(
      /attempts = attempts \+ :one.*REMOVE leaseUntil, leaseOwner/,
    );
  });

  it('markAmbiguous is conditional on the observed lease', async () => {
    const { client, sent } = fakeClient();
    const store = new DynamoDeliveriesStore(client, 'deliveries');
    await store.markAmbiguous({ deliveryId: ID, leaseOwner: 'req-1', leaseUntil: 77, now: NOW });
    expect(sent[0]?.input).toMatchObject({
      ConditionExpression: '#s = :claimed AND leaseOwner = :owner AND leaseUntil = :lease',
    });
    expect(sent[0]?.input.ExpressionAttributeValues).toMatchObject({
      ':owner': 'req-1',
      ':lease': 77,
      ':ambiguous': 'AMBIGUOUS',
    });
  });

  it('get uses a consistent read and maps the item', async () => {
    const { client, sent } = fakeClient([
      {
        Item: {
          deliveryId: ID,
          status: 'SENT',
          attempts: 2,
          updatedAt: 'x',
          expiresAt: 5,
          sesMessageId: 'm',
        },
      },
    ]);
    const store = new DynamoDeliveriesStore(client, 'deliveries');
    await expect(store.get(ID)).resolves.toEqual({
      deliveryId: ID,
      status: 'SENT',
      attempts: 2,
      updatedAt: 'x',
      expiresAt: 5,
      sesMessageId: 'm',
    });
    expect(sent[0]?.input).toMatchObject({ ConsistentRead: true });
  });

  it('get rejects an unknown status instead of guessing', async () => {
    const { client } = fakeClient([{ Item: { deliveryId: ID, status: 'WHATEVER' } }]);
    await expect(new DynamoDeliveriesStore(client, 'deliveries').get(ID)).rejects.toThrow();
  });
});

describe('DynamoSuppressions', () => {
  it('upsert keeps the first createdAt', async () => {
    const { client, sent } = fakeClient();
    await new DynamoSuppressions(client, 'suppressions').upsert({
      emailHash: 'h',
      reason: 'complaint',
      source: 'ses-complaint',
      at: NOW,
    });
    expect(String(sent[0]?.input.UpdateExpression)).toContain(
      'createdAt = if_not_exists(createdAt, :at)',
    );
  });
});

describe('DynamoPendingDigest', () => {
  it('add is idempotent: a duplicate request is not an error', async () => {
    const { client } = fakeClient([conditionFailed()]);
    const repo = new DynamoPendingDigest(client, 'pending-digest');
    await expect(
      repo.add({
        userId: 'u-1',
        sk: 'x#y',
        requestId: '6f1c2a40-3b7e-4c1d-9a8e-2f4b5c6d7e8f',
        category: 'comment_added',
        entityId: 'e',
        occurredAt: 'x',
        data: {},
        segment: 1,
        expiresAt: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it('remove deletes in batches of 25 and retries unprocessed items', async () => {
    const keys = Array.from({ length: 30 }, (_, i) => `k${i}`);
    const { client, sent } = fakeClient([
      {
        UnprocessedItems: {
          'pending-digest': [{ DeleteRequest: { Key: { userId: 'u-1', sk: 'k0' } } }],
        },
      },
      {},
      {},
    ]);
    await new DynamoPendingDigest(client, 'pending-digest').remove('u-1', keys);
    expect(sent.map((s) => s.name)).toEqual([
      'BatchWriteCommand',
      'BatchWriteCommand',
      'BatchWriteCommand',
    ]);
    const first = sent[0]?.input.RequestItems as Record<string, unknown[]>;
    expect(first['pending-digest']).toHaveLength(25);
  });
});

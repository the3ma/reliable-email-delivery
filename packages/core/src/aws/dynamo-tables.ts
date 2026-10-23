import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { DeliveryLogItem, DeliveryLogWriter } from '../delivery-log.js';
import type { Listing, PendingDigestRepository, SubscriptionsRepository } from '../repositories.js';
import { PendingDigestItemSchema, SubscriptionSchema } from '../schemas.js';
import type { PendingDigestItem, Subscription } from '../schemas.js';
import type {
  SuppressionReason,
  SuppressionRecord,
  SuppressionStore,
  SuppressionUpsert,
} from '../suppression.js';
import { isConditionalCheckFailed } from './dynamo-deliveries.js';

export const BY_SEGMENT_INDEX = 'by-segment';

async function queryAll(
  client: DynamoDBDocumentClient,
  input: ConstructorParameters<typeof QueryCommand>[0],
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({ ...input, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }),
    );
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

function parseAll<T>(
  rows: Record<string, unknown>[],
  parse: (row: unknown) => { success: true; data: T } | { success: false },
): Listing<T> {
  const items: T[] = [];
  let invalid = 0;
  for (const row of rows) {
    const result = parse(row);
    if (result.success) items.push(result.data);
    else invalid += 1;
  }
  return { items, invalid };
}

export class DynamoSubscriptions implements SubscriptionsRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async get(userId: string): Promise<Subscription | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { userId } }),
    );
    if (!result.Item) return undefined;
    const parsed = SubscriptionSchema.safeParse(result.Item);
    if (!parsed.success) throw new Error('subscription item failed validation');
    return parsed.data;
  }

  async listBySegment(segment: number): Promise<Listing<Subscription>> {
    const rows = await queryAll(this.client, {
      TableName: this.tableName,
      IndexName: BY_SEGMENT_INDEX,
      KeyConditionExpression: '#seg = :seg',
      ExpressionAttributeNames: { '#seg': 'segment' },
      ExpressionAttributeValues: { ':seg': segment },
    });
    return parseAll(rows, (row) => SubscriptionSchema.safeParse(row));
  }

  async put(subscription: Subscription): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: subscription }));
  }
}

export class DynamoPendingDigest implements PendingDigestRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async add(item: PendingDigestItem): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(sk)',
        }),
      );
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
    }
  }

  async listForUser(userId: string): Promise<Listing<PendingDigestItem>> {
    const rows = await queryAll(this.client, {
      TableName: this.tableName,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
      ConsistentRead: true,
    });
    return parseAll(rows, (row) => PendingDigestItemSchema.safeParse(row));
  }

  async remove(userId: string, sortKeys: readonly string[]): Promise<void> {
    for (let i = 0; i < sortKeys.length; i += 25) {
      let requests: Record<string, { DeleteRequest: { Key: Record<string, string> } }[]> = {
        [this.tableName]: sortKeys
          .slice(i, i + 25)
          .map((sk) => ({ DeleteRequest: { Key: { userId, sk } } })),
      };
      // BatchWrite may return unprocessed items under throttling; retry them with backoff.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await this.client.send(new BatchWriteCommand({ RequestItems: requests }));
        const unprocessed = result.UnprocessedItems?.[this.tableName];
        if (!unprocessed || unprocessed.length === 0) break;
        if (attempt === 4) throw new Error('pending-digest delete left unprocessed items');
        requests = { [this.tableName]: unprocessed as (typeof requests)[string] };
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      }
    }
  }
}

const REASONS = new Set<SuppressionReason>(['bounce_permanent', 'complaint', 'manual']);

export class DynamoSuppressions implements SuppressionStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async get(emailHash: string): Promise<SuppressionRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { emailHash }, ConsistentRead: true }),
    );
    const item = result.Item;
    if (!item) return undefined;
    const reason = REASONS.has(item.reason as SuppressionReason)
      ? (item.reason as SuppressionReason)
      : 'manual';
    return {
      emailHash,
      reason,
      source: typeof item.source === 'string' ? item.source : 'unknown',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
      lastEventAt: typeof item.lastEventAt === 'string' ? item.lastEventAt : '',
    };
  }

  async upsert(entry: SuppressionUpsert): Promise<void> {
    const at = entry.at.toISOString();
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { emailHash: entry.emailHash },
        UpdateExpression:
          'SET reason = :r, #src = :s, lastEventAt = :at, createdAt = if_not_exists(createdAt, :at)',
        ExpressionAttributeNames: { '#src': 'source' },
        ExpressionAttributeValues: { ':r': entry.reason, ':s': entry.source, ':at': at },
      }),
    );
  }
}

export class DynamoDeliveryLog implements DeliveryLogWriter {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async put(item: DeliveryLogItem): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }
}

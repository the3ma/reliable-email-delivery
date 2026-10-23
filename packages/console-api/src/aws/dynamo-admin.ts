import { BatchWriteCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeliveryStatus } from '@mail/core';
import type {
  DeliveryLogItem,
  DeliveryRecord,
  SuppressionReason,
  SuppressionRecord,
} from '@mail/core';
import type { DeliveriesAdmin, DeliveryLogAdmin, SuppressionsAdmin, TableAdmin } from '../ports.js';

type Item = Record<string, unknown>;

export async function scanAll(client: DynamoDBDocumentClient, tableName: string): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Item | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: tableName,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

export async function deleteKeys(
  client: DynamoDBDocumentClient,
  tableName: string,
  keys: readonly Item[],
): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    let requests = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 0; requests.length > 0; attempt += 1) {
      if (attempt === 5) throw new Error(`delete from ${tableName} left unprocessed items`);
      const result = await client.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: requests } }),
      );
      requests = (result.UnprocessedItems?.[tableName] ?? []) as typeof requests;
      if (requests.length > 0)
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}

function pick(item: Item, keyNames: readonly string[]): Item {
  return Object.fromEntries(keyNames.map((name) => [name, item[name]]));
}

/** Generic scan-and-delete for a table identified by its key attribute names. */
export class DynamoTableAdmin implements TableAdmin {
  constructor(
    protected readonly client: DynamoDBDocumentClient,
    protected readonly tableName: string,
    protected readonly keyNames: readonly string[],
  ) {}

  async count(): Promise<number> {
    let total = 0;
    let startKey: Item | undefined;
    do {
      const page = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          Select: 'COUNT',
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      total += page.Count ?? 0;
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return total;
  }

  async clear(keep: (item: Item) => boolean = () => false): Promise<number> {
    const doomed = (await scanAll(this.client, this.tableName)).filter((item) => !keep(item));
    await deleteKeys(
      this.client,
      this.tableName,
      doomed.map((item) => pick(item, this.keyNames)),
    );
    return doomed.length;
  }
}

const STATUSES = new Set<string>(Object.values(DeliveryStatus));

function toDelivery(item: Item): DeliveryRecord | undefined {
  if (
    typeof item.deliveryId !== 'string' ||
    typeof item.status !== 'string' ||
    !STATUSES.has(item.status)
  ) {
    return undefined;
  }
  const record: DeliveryRecord = {
    deliveryId: item.deliveryId,
    status: item.status as DeliveryRecord['status'],
    attempts: typeof item.attempts === 'number' ? item.attempts : 0,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    expiresAt: typeof item.expiresAt === 'number' ? item.expiresAt : 0,
  };
  for (const key of [
    'reason',
    'sesMessageId',
    'userId',
    'category',
    'toMasked',
    'leaseOwner',
  ] as const) {
    const value = item[key];
    if (typeof value === 'string') record[key] = value;
  }
  if (item.kind === 'immediate' || item.kind === 'digest') record.kind = item.kind;
  if (typeof item.leaseUntil === 'number') record.leaseUntil = item.leaseUntil;
  return record;
}

export class DynamoDeliveriesAdmin implements DeliveriesAdmin {
  private readonly table: DynamoTableAdmin;

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    this.table = new DynamoTableAdmin(client, tableName, ['deliveryId']);
  }

  async list(): Promise<DeliveryRecord[]> {
    return (await scanAll(this.client, this.tableName))
      .map(toDelivery)
      .filter((record): record is DeliveryRecord => record !== undefined);
  }

  clear(): Promise<number> {
    return this.table.clear();
  }
}

export class DynamoDeliveryLogAdmin implements DeliveryLogAdmin {
  private readonly table: DynamoTableAdmin;

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    this.table = new DynamoTableAdmin(client, tableName, ['deliveryId', 'sk']);
  }

  async events(deliveryId: string): Promise<DeliveryLogItem[]> {
    const items: Item[] = [];
    let startKey: Item | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'deliveryId = :d',
          ExpressionAttributeValues: { ':d': deliveryId },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      items.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return items as unknown as DeliveryLogItem[];
  }

  clear(): Promise<number> {
    return this.table.clear();
  }
}

const REASONS = new Set<string>(['bounce_permanent', 'complaint', 'manual']);

function toSuppression(item: Item): SuppressionRecord | undefined {
  if (typeof item.emailHash !== 'string') return undefined;
  return {
    emailHash: item.emailHash,
    reason: (typeof item.reason === 'string' && REASONS.has(item.reason)
      ? item.reason
      : 'manual') as SuppressionReason,
    source: typeof item.source === 'string' ? item.source : 'unknown',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    lastEventAt: typeof item.lastEventAt === 'string' ? item.lastEventAt : '',
  };
}

export class DynamoSuppressionsAdmin implements SuppressionsAdmin {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async list(): Promise<SuppressionRecord[]> {
    return (await scanAll(this.client, this.tableName))
      .map(toSuppression)
      .filter((record): record is SuppressionRecord => record !== undefined);
  }

  async clear(keep: (record: SuppressionRecord) => boolean): Promise<number> {
    const doomed = (await this.list()).filter((record) => !keep(record));
    await deleteKeys(
      this.client,
      this.tableName,
      doomed.map((record) => ({ emailHash: record.emailHash })),
    );
    return doomed.length;
  }
}

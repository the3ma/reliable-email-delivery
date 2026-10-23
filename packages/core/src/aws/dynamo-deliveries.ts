import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeliveryStatus } from '../deliveries.js';
import type {
  ClaimRequest,
  Completion,
  DeliveriesStore,
  DeliveryRecord,
  LeaseRef,
} from '../deliveries.js';

export function isConditionalCheckFailed(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

async function conditional(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) return false;
    throw error;
  }
}

const STATUSES = new Set<string>(Object.values(DeliveryStatus));

function toRecord(item: Record<string, unknown>): DeliveryRecord {
  const status = item.status;
  if (typeof status !== 'string' || !STATUSES.has(status)) {
    throw new Error('deliveries item has an unknown status');
  }
  const record: DeliveryRecord = {
    deliveryId: String(item.deliveryId),
    status: status as DeliveryStatus,
    attempts: typeof item.attempts === 'number' ? item.attempts : 0,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    expiresAt: typeof item.expiresAt === 'number' ? item.expiresAt : 0,
  };
  if (typeof item.leaseUntil === 'number') record.leaseUntil = item.leaseUntil;
  if (typeof item.leaseOwner === 'string') record.leaseOwner = item.leaseOwner;
  if (typeof item.sesMessageId === 'string') record.sesMessageId = item.sesMessageId;
  if (typeof item.reason === 'string') record.reason = item.reason;
  return record;
}

/** `status` is a DynamoDB reserved word, hence `#s` everywhere. */
export class DynamoDeliveriesStore implements DeliveriesStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  claim(request: ClaimRequest): Promise<boolean> {
    // An UpdateItem upsert has the same condition as the contract's PutItem claim but keeps
    // `attempts` from a RELEASED item instead of overwriting it.
    return conditional(() =>
      this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { deliveryId: request.deliveryId },
          UpdateExpression:
            'SET #s = :claimed, leaseOwner = :owner, leaseUntil = :lease, updatedAt = :now, ' +
            'expiresAt = :exp, attempts = if_not_exists(attempts, :zero) REMOVE reason',
          ConditionExpression: 'attribute_not_exists(deliveryId) OR #s = :released',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':claimed': DeliveryStatus.CLAIMED,
            ':released': DeliveryStatus.RELEASED,
            ':owner': request.owner,
            ':lease': request.leaseUntil,
            ':now': request.now.toISOString(),
            ':exp': request.expiresAt,
            ':zero': 0,
          },
        }),
      ),
    );
  }

  async get(deliveryId: string): Promise<DeliveryRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { deliveryId }, ConsistentRead: true }),
    );
    return result.Item ? toRecord(result.Item) : undefined;
  }

  markAmbiguous(lease: LeaseRef): Promise<boolean> {
    const ownerCondition =
      lease.leaseOwner === undefined ? 'attribute_not_exists(leaseOwner)' : 'leaseOwner = :owner';
    const leaseCondition =
      lease.leaseUntil === undefined ? 'attribute_not_exists(leaseUntil)' : 'leaseUntil = :lease';
    const values: Record<string, unknown> = {
      ':claimed': DeliveryStatus.CLAIMED,
      ':ambiguous': DeliveryStatus.AMBIGUOUS,
      ':reason': 'lease_expired',
      ':now': lease.now.toISOString(),
    };
    if (lease.leaseOwner !== undefined) values[':owner'] = lease.leaseOwner;
    if (lease.leaseUntil !== undefined) values[':lease'] = lease.leaseUntil;
    return conditional(() =>
      this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { deliveryId: lease.deliveryId },
          UpdateExpression: 'SET #s = :ambiguous, reason = :reason, updatedAt = :now',
          ConditionExpression: `#s = :claimed AND ${ownerCondition} AND ${leaseCondition}`,
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: values,
        }),
      ),
    );
  }

  complete(deliveryId: string, owner: string, now: Date, completion: Completion): Promise<boolean> {
    const values: Record<string, unknown> = {
      ':claimed': DeliveryStatus.CLAIMED,
      ':me': owner,
      ':status': completion.status,
      ':now': now.toISOString(),
    };
    let update: string;
    switch (completion.status) {
      case DeliveryStatus.SENT:
        update = 'SET #s = :status, sesMessageId = :mid, updatedAt = :now REMOVE leaseUntil';
        values[':mid'] = completion.sesMessageId;
        break;
      case DeliveryStatus.FAILED_PERMANENT:
        update = 'SET #s = :status, reason = :reason, updatedAt = :now REMOVE leaseUntil';
        values[':reason'] = completion.reason;
        break;
      case DeliveryStatus.RELEASED:
        update =
          'SET #s = :status, reason = :reason, updatedAt = :now, attempts = attempts + :one ' +
          'REMOVE leaseUntil, leaseOwner';
        values[':reason'] = completion.reason;
        values[':one'] = 1;
        break;
    }
    return conditional(() =>
      this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { deliveryId },
          UpdateExpression: update,
          ConditionExpression: '#s = :claimed AND leaseOwner = :me',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: values,
        }),
      ),
    );
  }

  skip(deliveryId: string, reason: string, now: Date, expiresAt: number): Promise<boolean> {
    return conditional(() =>
      this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { deliveryId },
          UpdateExpression:
            'SET #s = :skipped, reason = :reason, updatedAt = :now, expiresAt = :exp, ' +
            'attempts = if_not_exists(attempts, :zero)',
          ConditionExpression: 'attribute_not_exists(deliveryId) OR #s = :released',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':skipped': DeliveryStatus.SKIPPED,
            ':released': DeliveryStatus.RELEASED,
            ':reason': reason,
            ':now': now.toISOString(),
            ':exp': expiresAt,
            ':zero': 0,
          },
        }),
      ),
    );
  }
}

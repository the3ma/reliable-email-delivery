import { aws_dynamodb as dynamodb, type aws_kms as kms, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export const SEGMENT_INDEX = 'by-segment';

export interface StorageProps {
  readonly prefix: string;
  readonly key: kms.IKey;
  readonly protect: boolean;
}

interface TableSpec {
  readonly name: string;
  readonly sortKey?: string;
  readonly ttl?: string;
  readonly segmentIndex?: boolean;
}

/** The five tables of CONTRACT section 4: on-demand, CMK-encrypted, PITR, protected in prod. */
export class Storage extends Construct {
  readonly subscriptions: dynamodb.Table;
  readonly pendingDigest: dynamodb.Table;
  readonly deliveries: dynamodb.Table;
  readonly deliveryLog: dynamodb.Table;
  readonly suppressions: dynamodb.Table;

  constructor(
    scope: Construct,
    id: string,
    private readonly props: StorageProps,
  ) {
    super(scope, id);
    this.subscriptions = this.table('Subscriptions', 'userId', {
      name: 'subscriptions',
      segmentIndex: true,
    });
    this.pendingDigest = this.table('PendingDigest', 'userId', {
      name: 'pending-digest',
      sortKey: 'sk', // `occurredAt#requestId`
      ttl: 'expiresAt',
      segmentIndex: true,
    });
    this.deliveries = this.table('Deliveries', 'deliveryId', {
      name: 'deliveries',
      ttl: 'expiresAt',
    });
    this.deliveryLog = this.table('DeliveryLog', 'deliveryId', {
      name: 'delivery-log',
      sortKey: 'sk', // `at#event`
      ttl: 'expiresAt',
    });
    // No TTL: a suppression outlives everything else on purpose.
    this.suppressions = this.table('Suppressions', 'emailHash', { name: 'suppressions' });
  }

  get all(): dynamodb.Table[] {
    return [
      this.subscriptions,
      this.pendingDigest,
      this.deliveries,
      this.deliveryLog,
      this.suppressions,
    ];
  }

  private table(id: string, partitionKey: string, spec: TableSpec): dynamodb.Table {
    const { prefix, key, protect } = this.props;
    const table = new dynamodb.Table(this, id, {
      tableName: `${prefix}-${spec.name}`,
      partitionKey: { name: partitionKey, type: dynamodb.AttributeType.STRING },
      ...(spec.sortKey
        ? { sortKey: { name: spec.sortKey, type: dynamodb.AttributeType.STRING } }
        : {}),
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      ...(spec.ttl ? { timeToLiveAttribute: spec.ttl } : {}),
      deletionProtection: protect,
      removalPolicy: protect ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    if (spec.segmentIndex) {
      table.addGlobalSecondaryIndex({
        indexName: SEGMENT_INDEX,
        partitionKey: { name: 'segment', type: dynamodb.AttributeType.NUMBER },
        sortKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
    }
    return table;
  }
}

import { Match } from 'aws-cdk-lib/assertions';
import { type Json, ofType, PROD, props, refId, synth } from './helpers';

const dev = synth();
const prod = synth(PROD);

const segmentIndex = [
  {
    IndexName: 'by-segment',
    KeySchema: [
      { AttributeName: 'segment', KeyType: 'HASH' },
      { AttributeName: 'userId', KeyType: 'RANGE' },
    ],
    Projection: { ProjectionType: 'ALL' },
  },
];

// CONTRACT section 4.
const tables = [
  { name: 'subscriptions', keys: [['userId', 'HASH']], ttl: undefined, gsi: segmentIndex },
  {
    name: 'pending-digest',
    keys: [
      ['userId', 'HASH'],
      ['sk', 'RANGE'],
    ],
    ttl: 'expiresAt',
    gsi: segmentIndex,
  },
  { name: 'deliveries', keys: [['deliveryId', 'HASH']], ttl: 'expiresAt', gsi: undefined },
  {
    name: 'delivery-log',
    keys: [
      ['deliveryId', 'HASH'],
      ['sk', 'RANGE'],
    ],
    ttl: 'expiresAt',
    gsi: undefined,
  },
  { name: 'suppressions', keys: [['emailHash', 'HASH']], ttl: undefined, gsi: undefined },
];

describe('tables', () => {
  it('creates exactly the five contract tables', () => {
    expect(ofType(dev.resources, 'AWS::DynamoDB::Table')).toHaveLength(5);
  });

  it.each(tables)('$name: keys, GSI, TTL, on-demand, CMK, PITR', ({ name, keys, ttl, gsi }) => {
    dev.template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: `mail-dev-${name}`,
      KeySchema: keys.map(([AttributeName, KeyType]) => ({ AttributeName, KeyType })),
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: Match.anyValue() },
      TimeToLiveSpecification: ttl ? { AttributeName: ttl, Enabled: true } : Match.absent(),
      GlobalSecondaryIndexes: gsi ?? Match.absent(),
    });
  });

  it('every table is encrypted with the stack key', () => {
    const keyId = ofType(dev.resources, 'AWS::KMS::Key')[0]?.[0];
    for (const [, t] of ofType(dev.resources, 'AWS::DynamoDB::Table')) {
      const sse = props(t).SSESpecification as { KMSMasterKeyId: Json };
      expect(refId(sse.KMSMasterKeyId)).toBe(keyId);
    }
  });

  it('segment is a number attribute (hash mod 16)', () => {
    dev.template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'mail-dev-subscriptions',
      AttributeDefinitions: Match.arrayWith([{ AttributeName: 'segment', AttributeType: 'N' }]),
    });
  });

  it('prod: deletion protection and RETAIN on every table', () => {
    for (const [, t] of ofType(prod.resources, 'AWS::DynamoDB::Table')) {
      expect(props(t).DeletionProtectionEnabled).toBe(true);
      expect(t.DeletionPolicy).toBe('Retain');
      expect(t.UpdateReplacePolicy).toBe('Retain');
    }
  });

  it('dev: disposable tables', () => {
    for (const [, t] of ofType(dev.resources, 'AWS::DynamoDB::Table')) {
      expect(props(t).DeletionProtectionEnabled).toBe(false);
      expect(t.DeletionPolicy).toBe('Delete');
    }
  });
});

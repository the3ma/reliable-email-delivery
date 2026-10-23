import { describe, expect, it } from 'vitest';
import { NotificationRequestSchema, SubscriptionSchema, stableSegment } from '@mail/core';
import type { Message } from '@aws-sdk/client-sqs';
import { localContext, parseArgs } from '../src/cli/local.js';
import { generateRequests, mulberry32 } from '../src/cli/publish-data.js';
import { seedSubscription, userId } from '../src/cli/seed-data.js';
import { queueArn, toSqsEvent } from '../src/cli/sqs-worker.js';

describe('parseArgs', () => {
  const known = { segment: 'string', all: 'boolean' } as const;

  it('parses values, inline values and flags', () => {
    expect(parseArgs(['--segment', '3', '--all'], known)).toEqual({ segment: '3', all: true });
    expect(parseArgs(['--segment=4'], known)).toEqual({ segment: '4' });
  });

  it('rejects unknown options, positional arguments and missing values', () => {
    expect(() => parseArgs(['--segmnet', '3'], known)).toThrow(/unknown option/);
    expect(() => parseArgs(['3'], known)).toThrow(/unexpected argument/);
    expect(() => parseArgs(['--segment'], known)).toThrow(/needs a value/);
    expect(() => parseArgs(['--segment', '--all'], known)).toThrow(/needs a value/);
  });
});

describe('local worker plumbing', () => {
  it('derives the queue ARN from a queue URL', () => {
    expect(queueArn('http://localstack:4566/000000000000/email', 'us-east-1')).toBe(
      'arn:aws:sqs:us-east-1:000000000000:email',
    );
  });

  it('shapes ReceiveMessage output like the Lambda SQS event source', () => {
    const messages: Message[] = [
      {
        MessageId: 'm1',
        ReceiptHandle: 'rh1',
        Body: '{"a":1}',
        MD5OfBody: 'x',
        Attributes: { ApproximateReceiveCount: '2', SentTimestamp: '1' },
        MessageAttributes: { kind: { DataType: 'String', StringValue: 'digest' } },
      },
    ];
    const event = toSqsEvent(messages, 'arn:aws:sqs:us-east-1:0:email', 'us-east-1');
    expect(event.Records[0]).toMatchObject({
      messageId: 'm1',
      receiptHandle: 'rh1',
      body: '{"a":1}',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-east-1:0:email',
      attributes: { ApproximateReceiveCount: '2' },
      messageAttributes: { kind: { dataType: 'String', stringValue: 'digest' } },
    });
  });

  it('local contexts count down from the timeout', () => {
    const ctx = localContext('processor', 60_000);
    expect(ctx.getRemainingTimeInMillis()).toBeGreaterThan(59_000);
    expect(ctx.awsRequestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('seed data', () => {
  it('produces valid subscriptions with stable segments and example.test addresses', () => {
    for (let i = 1; i <= 40; i += 1) {
      const subscription = SubscriptionSchema.parse(seedSubscription(i, 16));
      expect(subscription.userId).toBe(userId(i));
      expect(subscription.email).toMatch(/@example\.test$/);
      expect(subscription.segment).toBe(stableSegment(subscription.userId, 16));
    }
  });
});

describe('publish data', () => {
  it('is deterministic for a seed (apart from fresh request ids)', () => {
    const shape = (seed: number) =>
      generateRequests({ count: 50, users: 10, seed, now: new Date('2026-10-23T07:00:00Z') }).map(
        (r) => [r.kind, r.detail.category, r.detail.userId],
      );
    expect(shape(7)).toEqual(shape(7));
    expect(mulberry32(1)()).toBe(mulberry32(1)());
  });

  it('mixes valid traffic with duplicates and invalid requests', () => {
    const requests = generateRequests({ count: 400, users: 40, seed: 42 });
    const kinds = new Map<string, number>();
    for (const r of requests) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
    expect(kinds.get('duplicate')).toBeGreaterThan(10);
    expect(kinds.get('invalid')).toBeGreaterThan(2);

    for (const r of requests.filter((x) => x.kind !== 'invalid')) {
      expect(NotificationRequestSchema.safeParse(r.detail).success).toBe(true);
    }
    const schemaInvalid = requests.filter(
      (r) => r.kind === 'invalid' && !NotificationRequestSchema.safeParse(r.detail).success,
    );
    expect(schemaInvalid.length).toBeGreaterThan(0);
    expect(new Set(requests.map((r) => r.detail.category)).size).toBeGreaterThanOrEqual(4);
  });
});

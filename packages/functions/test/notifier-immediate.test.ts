import { describe, expect, it } from 'vitest';
import { DeliveryStatus, EmailMessageSchema, immediateDeliveryId, stableSegment } from '@mail/core';
import type { Subscription } from '@mail/core';
import {
  InMemoryDeliveriesStore,
  InMemoryPendingDigest,
  InMemorySubscriptions,
} from '@mail/core/testing';
import { createNotifierImmediate, routeFor } from '../src/app/notifier-immediate.js';
import { MemoryEmailQueue } from '../src/lib/email-queue.js';
import {
  CountingTelemetry,
  FIXED_NOW,
  captureOutput,
  context,
  sqsEvent,
  testLog,
} from './helpers.js';

const SUB: Subscription = {
  userId: 'u-123',
  email: 'ada@example.test',
  timezone: 'Europe/Berlin',
  locale: 'en',
  immediate: ['report_ready', 'comment_added'],
  digest: ['usage_alert'],
  segment: stableSegment('u-123'),
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    requestId: '6f1c2a40-3b7e-4c1d-9a8e-2f4b5c6d7e8f',
    userId: 'u-123',
    category: 'report_ready',
    entityId: 'rep-77',
    occurredAt: '2026-10-23T07:15:00Z',
    data: { reportName: 'Q3 usage' },
    ...overrides,
  };
}

async function setup() {
  captureOutput();
  const subscriptions = new InMemorySubscriptions();
  await subscriptions.put(SUB);
  const pendingDigest = new InMemoryPendingDigest();
  const deliveries = new InMemoryDeliveriesStore();
  const emailQueue = new MemoryEmailQueue();
  const telemetry = new CountingTelemetry();
  const run = createNotifierImmediate({
    subscriptions,
    pendingDigest,
    deliveries,
    emailQueue,
    log: testLog(),
    telemetry,
    appBaseUrl: 'https://app.example.test',
    clock: () => FIXED_NOW,
  });
  return { run, subscriptions, pendingDigest, deliveries, emailQueue, telemetry };
}

describe('routeFor', () => {
  it('immediate only with a template, digest otherwise, none when unsubscribed', () => {
    const base = request() as Parameters<typeof routeFor>[1];
    expect(routeFor(SUB, { ...base, category: 'report_ready' })).toBe('immediate');
    expect(routeFor(SUB, { ...base, category: 'comment_added' })).toBe('digest');
    expect(routeFor(SUB, { ...base, category: 'usage_alert' })).toBe('digest');
    expect(routeFor(SUB, { ...base, category: 'invoice_failed' })).toBe('none');
  });
});

describe('notifier-immediate', () => {
  it('renders and queues a valid email message for an immediate category', async () => {
    const { run, emailQueue, telemetry } = await setup();
    const result = await run(sqsEvent(request()), context());
    expect(result.batchItemFailures).toEqual([]);
    expect(emailQueue.messages).toHaveLength(1);
    const message = EmailMessageSchema.parse(emailQueue.messages[0]);
    expect(message).toMatchObject({
      deliveryId: immediateDeliveryId('u-123', 'report_ready', 'rep-77'),
      to: 'ada@example.test',
      templateId: 'report_ready',
      kind: 'immediate',
      subject: 'Your report "Q3 usage" is ready',
      requestIds: ['6f1c2a40-3b7e-4c1d-9a8e-2f4b5c6d7e8f'],
      redact: false,
    });
    expect(message.html).toContain('https://app.example.test/reports/rep-77');
    expect(telemetry.get('NotificationsQueued')).toBe(1);
  });

  it('invoice_failed messages are flagged redact=true', async () => {
    const { run, emailQueue, subscriptions } = await setup();
    await subscriptions.put({ ...SUB, immediate: ['invoice_failed'] });
    await run(
      sqsEvent(
        request({
          category: 'invoice_failed',
          entityId: 'inv-1',
          data: { invoiceNumber: 'INV-1', amount: 10, currency: 'EUR' },
        }),
      ),
      context(),
    );
    expect(emailQueue.messages[0]?.redact).toBe(true);
  });

  it('a producer re-emitting the same entity yields the same deliveryId', async () => {
    const { run, emailQueue } = await setup();
    await run(
      sqsEvent(request(), request({ requestId: '0b8f3c1e-9d2a-4f5b-8c7d-1e2f3a4b5c6d' })),
      context(),
    );
    expect(emailQueue.messages).toHaveLength(2);
    expect(emailQueue.messages[0]?.deliveryId).toBe(emailQueue.messages[1]?.deliveryId);
  });

  it('skips a deliveryId already present in deliveries (upstream dedup)', async () => {
    const { run, emailQueue, deliveries, telemetry } = await setup();
    const id = immediateDeliveryId('u-123', 'report_ready', 'rep-77');
    deliveries.items.set(id, {
      deliveryId: id,
      status: DeliveryStatus.SENT,
      attempts: 0,
      updatedAt: '',
      expiresAt: 0,
    });
    await run(sqsEvent(request()), context());
    expect(emailQueue.messages).toHaveLength(0);
    expect(telemetry.get('DuplicatesSuppressed')).toBe(1);
  });

  it('digest categories become pending-digest items (idempotent per request)', async () => {
    const { run, pendingDigest, emailQueue } = await setup();
    const body = request({
      category: 'usage_alert',
      entityId: 'use-1',
      data: { metric: 'API calls' },
    });
    await run(sqsEvent(body, body), context());
    expect(emailQueue.messages).toHaveLength(0);
    const { items } = await pendingDigest.listForUser('u-123');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sk: '2026-10-23T07:15:00Z#6f1c2a40-3b7e-4c1d-9a8e-2f4b5c6d7e8f',
      category: 'usage_alert',
      segment: SUB.segment,
      expiresAt: Math.floor(FIXED_NOW.getTime() / 1000) + 14 * 86_400,
    });
  });

  it('immediate preference without a template falls back to the digest', async () => {
    const { run, pendingDigest, emailQueue } = await setup();
    await run(
      sqsEvent(request({ category: 'comment_added', entityId: 'doc-1', data: { subject: 'Doc' } })),
      context(),
    );
    expect(emailQueue.messages).toHaveLength(0);
    expect((await pendingDigest.listForUser('u-123')).items).toHaveLength(1);
  });

  it.each([
    ['not JSON', '{'],
    ['unknown category', request({ category: 'newsletter' })],
    ['missing userId', { ...request(), userId: undefined }],
    ['template variable missing', request({ data: {} })],
  ])('invalid (%s) -> dropped, never retried', async (_label, body) => {
    const { run, emailQueue, telemetry } = await setup();
    const result = await run(sqsEvent(body), context());
    expect(result.batchItemFailures).toEqual([]);
    expect(emailQueue.messages).toHaveLength(0);
    expect(telemetry.get('InvalidMessages')).toBe(1);
  });

  it('unknown user and unsubscribed category are dropped', async () => {
    const { run, emailQueue, telemetry } = await setup();
    await run(
      sqsEvent(request({ userId: 'u-999' }), request({ category: 'invoice_failed' })),
      context(),
    );
    expect(emailQueue.messages).toHaveLength(0);
    expect(telemetry.get('EmailsSkipped')).toBe(2);
  });

  it('a queue outage is transient: batch item failure', async () => {
    const { run, emailQueue } = await setup();
    emailQueue.failWith = new Error('sqs down');
    const event = sqsEvent(request());
    const result = await run(event, context());
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: event.Records[0]?.messageId }]);
  });
});

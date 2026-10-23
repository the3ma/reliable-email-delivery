import { describe, expect, it } from 'vitest';
import { ToggleCache, emailHash, immediateDeliveryId, pendingDigestSortKey } from '@mail/core';
import type { EmailMessage } from '@mail/core';
import {
  InMemoryDeliveriesStore,
  InMemoryDeliveryLog,
  InMemoryPendingDigest,
  InMemorySubscriptions,
  InMemorySuppressions,
  MemoryTransport,
  StaticToggleSource,
  awsError,
} from '@mail/core/testing';
import { createFeedback } from '../src/app/feedback.js';
import { createNotifierDigest } from '../src/app/notifier-digest.js';
import { createNotifierImmediate } from '../src/app/notifier-immediate.js';
import { createProcessor } from '../src/app/processor.js';
import { buildSesEvent } from '../src/app/ses-events.js';
import { MemoryEmailQueue } from '../src/lib/email-queue.js';
import { powertoolsTelemetry, captureOutput, context, sqsEvent, testLog } from './helpers.js';

/**
 * Runs every handler through success and failure paths with the real Powertools Logger and
 * Metrics, then scans everything written to stdout/stderr. Addresses must only ever appear
 * masked, and no body text may appear at all.
 */
const ADDRESSES = ['alpha.user@example.test', 'beta.user@example.test', 'bounce.user@example.test'];
const BODY_MARKERS = ['BODY-TEXT-MARKER-7f3a', 'BODY-HTML-MARKER-9c1d'];
// Masked addresses look like a***@example.test; two plain characters before an '@' is a leak.
const UNMASKED = /[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]+/g;

function scan(output: string): void {
  for (const address of ADDRESSES) expect(output).not.toContain(address);
  expect(output.match(UNMASKED) ?? []).toEqual([]);
  for (const marker of BODY_MARKERS) expect(output).not.toContain(marker);
}

function message(to: string, entityId: string): EmailMessage {
  return {
    deliveryId: immediateDeliveryId('u-1', 'report_ready', entityId),
    userId: 'u-1',
    to,
    templateId: 'report_ready',
    subject: 'Report ready',
    text: `Hello ${BODY_MARKERS[0] ?? ''}`,
    html: `<p>${BODY_MARKERS[1] ?? ''}</p>`,
    category: 'report_ready',
    kind: 'immediate',
    requestIds: ['6f1c2a40-3b7e-4c1d-9a8e-2f4b5c6d7e8f'],
    redact: false,
    createdAt: '2026-10-23T07:00:00Z',
  };
}

describe('no recipient data or bodies in log output', () => {
  it('processor: sent, permanent failure echoing the address, transient, invalid, suppressed', async () => {
    const output = captureOutput();
    const log = testLog();
    const { telemetry } = powertoolsTelemetry(log);
    const suppressions = new InMemorySuppressions();
    await suppressions.upsert({
      emailHash: emailHash(ADDRESSES[2] ?? ''),
      reason: 'complaint',
      source: 't',
      at: new Date(),
    });
    const transport = new MemoryTransport();
    // The second send fails with SES echoing the recipient in its error message.
    transport.onSend = () => undefined;
    const run = createProcessor({
      deliveries: new InMemoryDeliveriesStore(),
      deliveryLog: new InMemoryDeliveryLog(),
      suppressions,
      transport,
      toggles: new ToggleCache(
        new StaticToggleSource({ 'send-emails': 'enabled', 'record-deliveries': 'enabled' }),
      ),
      log,
      telemetry,
      fromAddress: 'notifications@example.test',
      hardDisabled: 'false',
    });
    await run(sqsEvent(message(ADDRESSES[0] ?? '', 'rep-1')), context());
    transport.failWith(
      awsError('MessageRejected', 400, `Email address is not verified: ${ADDRESSES[1] ?? ''}`),
      awsError('Throttling', 400, `Rate exceeded for ${ADDRESSES[0] ?? ''}`),
    );
    await run(sqsEvent(message(ADDRESSES[1] ?? '', 'rep-2')), context());
    await run(sqsEvent(message(ADDRESSES[0] ?? '', 'rep-3')), context());
    await run(sqsEvent({ ...message(ADDRESSES[0] ?? '', 'rep-4'), deliveryId: 'bad' }), context());
    await run(
      sqsEvent(`{"to":"${ADDRESSES[0] ?? ''}","text":"${BODY_MARKERS[0] ?? ''}"`),
      context(),
    );
    await run(sqsEvent(message(ADDRESSES[2] ?? '', 'rep-5')), context());

    const text = output.text();
    expect(text).toContain('a***@example.test'); // proves the capture sees the real log lines
    expect(text).toContain('"EmailDelivery"'); // and the EMF metrics
    scan(text);
  });

  it('notifier-immediate and notifier-digest', async () => {
    const output = captureOutput();
    const log = testLog();
    const { telemetry } = powertoolsTelemetry(log);
    const subscriptions = new InMemorySubscriptions();
    await subscriptions.put({
      userId: 'u-1',
      email: ADDRESSES[0] ?? '',
      timezone: 'UTC',
      locale: 'en',
      immediate: ['report_ready'],
      digest: ['comment_added'],
      segment: 1,
    });
    const pendingDigest = new InMemoryPendingDigest();
    const emailQueue = new MemoryEmailQueue();
    const deliveries = new InMemoryDeliveriesStore();
    const immediate = createNotifierImmediate({
      subscriptions,
      pendingDigest,
      deliveries,
      emailQueue,
      log,
      telemetry,
      appBaseUrl: 'https://app.example.test',
    });
    const request = {
      requestId: '6f1c2a40-3b7e-4c1d-9a8e-2f4b5c6d7e8f',
      userId: 'u-1',
      category: 'report_ready',
      entityId: 'rep-1',
      occurredAt: '2026-10-23T07:00:00Z',
      data: { reportName: `contact ${ADDRESSES[1] ?? ''}` },
    };
    await immediate(
      sqsEvent(request, { ...request, data: {} }, '{bad', { ...request, userId: ADDRESSES[1] }),
      context(),
    );

    await pendingDigest.add({
      userId: 'u-1',
      sk: pendingDigestSortKey('2026-10-23T06:00:00Z', request.requestId),
      requestId: request.requestId,
      category: 'comment_added',
      entityId: 'doc-1',
      occurredAt: '2026-10-23T06:00:00Z',
      data: { subject: 'Doc' },
      segment: 1,
      expiresAt: 0,
    });
    const digest = createNotifierDigest({
      subscriptions,
      pendingDigest,
      deliveries,
      emailQueue,
      log,
      telemetry,
      appBaseUrl: 'https://app.example.test',
      segments: 16,
      window: { startHour: 0, endHour: 24 },
    });
    await digest({ segment: 1 }, context(300_000));

    expect(emailQueue.messages.length).toBeGreaterThanOrEqual(2);
    const text = output.text();
    expect(text).toContain('a***@example.test');
    scan(text);
  });

  it('feedback', async () => {
    const output = captureOutput();
    const log = testLog();
    const { telemetry } = powertoolsTelemetry(log);
    const run = createFeedback({
      suppressions: new InMemorySuppressions(),
      deliveryLog: new InMemoryDeliveryLog(),
      log,
      telemetry,
    });
    for (const type of ['Bounce', 'Complaint', 'Delivery', 'Reject'] as const) {
      await run(buildSesEvent({ type, email: ADDRESSES[2] ?? '', deliveryId: '1'.repeat(64) }));
    }
    await run(buildSesEvent({ type: 'Bounce', email: ADDRESSES[0] ?? '' }));
    const text = output.text();
    expect(text).toContain('ses feedback processed');
    scan(text);
  });
});

import { describe, expect, it } from 'vitest';
import { emailHash } from '@mail/core';
import { InMemoryDeliveryLog, InMemorySuppressions } from '@mail/core/testing';
import { createFeedback } from '../src/app/feedback.js';
import { buildSesEvent } from '../src/app/ses-events.js';
import { CountingTelemetry, FIXED_NOW, captureOutput, testLog } from './helpers.js';

const EMAIL = 'ada@example.test';
const DELIVERY = '9'.repeat(64);

function setup() {
  captureOutput();
  const suppressions = new InMemorySuppressions();
  const deliveryLog = new InMemoryDeliveryLog();
  const telemetry = new CountingTelemetry();
  const run = createFeedback({
    suppressions,
    deliveryLog,
    log: testLog(),
    telemetry,
    clock: () => FIXED_NOW,
  });
  return { run, suppressions, deliveryLog, telemetry };
}

describe('feedback', () => {
  it('a permanent bounce suppresses the address (by hash) and logs a delivery row', async () => {
    const { run, suppressions, deliveryLog, telemetry } = setup();
    const result = await run(buildSesEvent({ type: 'Bounce', email: EMAIL, deliveryId: DELIVERY }));
    expect(result).toEqual({ eventType: 'Bounce', suppressed: 1, deliveryId: DELIVERY });
    expect(suppressions.items.get(emailHash(EMAIL))).toMatchObject({
      reason: 'bounce_permanent',
      source: 'ses-bounce',
    });
    expect(deliveryLog.items[0]).toMatchObject({ deliveryId: DELIVERY, event: 'bounced' });
    expect(deliveryLog.items[0]?.details).toMatchObject({
      bounceType: 'Permanent',
      recipients: ['a***@example.test'],
    });
    expect(telemetry.get('Bounces')).toBe(1);
    expect(telemetry.get('FeedbackEvents')).toBe(1);
  });

  it('a transient bounce is only logged, never suppressed', async () => {
    const { run, suppressions, deliveryLog } = setup();
    const result = await run(
      buildSesEvent({
        type: 'Bounce',
        email: EMAIL,
        deliveryId: DELIVERY,
        bounceType: 'Transient',
      }),
    );
    expect(result?.suppressed).toBe(0);
    expect(suppressions.items.size).toBe(0);
    expect(deliveryLog.events()).toEqual(['bounced']);
  });

  it('a complaint suppresses the address', async () => {
    const { run, suppressions, telemetry } = setup();
    await run(buildSesEvent({ type: 'Complaint', email: EMAIL, deliveryId: DELIVERY }));
    expect(suppressions.items.get(emailHash(EMAIL))).toMatchObject({ reason: 'complaint' });
    expect(telemetry.get('Complaints')).toBe(1);
  });

  it('a repeated event keeps the first createdAt', async () => {
    const { run, suppressions } = setup();
    await run(buildSesEvent({ type: 'Complaint', email: EMAIL }));
    const first = suppressions.items.get(emailHash(EMAIL))?.createdAt;
    await run(buildSesEvent({ type: 'Bounce', email: EMAIL.toUpperCase() }));
    expect(suppressions.items.size).toBe(1);
    expect(suppressions.items.get(emailHash(EMAIL))?.createdAt).toBe(first);
  });

  it('delivery and reject events become delivery-log rows', async () => {
    const { run, deliveryLog, suppressions } = setup();
    await run(buildSesEvent({ type: 'Delivery', email: EMAIL, deliveryId: DELIVERY }));
    await run(buildSesEvent({ type: 'Reject', email: EMAIL, deliveryId: DELIVERY }));
    expect(deliveryLog.events(DELIVERY)).toEqual(['delivered', 'rejected']);
    expect(suppressions.items.size).toBe(0);
  });

  it('without a deliveryId tag there is no delivery-log row, but suppression still happens', async () => {
    const { run, deliveryLog, suppressions } = setup();
    await run(buildSesEvent({ type: 'Bounce', email: EMAIL }));
    expect(deliveryLog.items).toHaveLength(0);
    expect(suppressions.items.size).toBe(1);
  });

  it('an unexpected shape is counted and ignored', async () => {
    const { run, telemetry } = setup();
    expect(await run({ detail: { nope: true } })).toBeUndefined();
    expect(telemetry.get('InvalidMessages')).toBe(1);
  });

  it('a suppression store outage throws so EventBridge retries', async () => {
    const { run, suppressions } = setup();
    suppressions.failWith = new Error('dynamo down');
    await expect(run(buildSesEvent({ type: 'Complaint', email: EMAIL }))).rejects.toThrow(
      'dynamo down',
    );
  });

  it('a delivery-log outage does not fail the event', async () => {
    const { run, deliveryLog, suppressions } = setup();
    deliveryLog.failWith = new Error('dynamo down');
    await expect(
      run(buildSesEvent({ type: 'Complaint', email: EMAIL, deliveryId: DELIVERY })),
    ).resolves.toBeDefined();
    expect(suppressions.items.size).toBe(1);
  });
});

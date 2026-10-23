import { describe, expect, it } from 'vitest';
import {
  DeliveryStatus,
  EmailMessageSchema,
  digestDeliveryId,
  messageLimitViolation,
  pendingDigestSortKey,
} from '@mail/core';
import type { Category, Subscription } from '@mail/core';
import {
  InMemoryDeliveriesStore,
  InMemoryPendingDigest,
  InMemorySubscriptions,
} from '@mail/core/testing';
import { randomUUID } from 'node:crypto';
import { createNotifierDigest } from '../src/app/notifier-digest.js';
import type { NotifierDigestDeps } from '../src/app/notifier-digest.js';
import { MemoryEmailQueue } from '../src/lib/email-queue.js';
import { CountingTelemetry, captureOutput, context, testLog } from './helpers.js';

// 06:30 UTC: 08:30 in Berlin (CEST, due), 02:30 in New York and 15:30 in Tokyo (not due).
const NOW = new Date('2026-10-23T06:30:00Z');

function sub(userId: string, timezone: string): Subscription {
  return {
    userId,
    email: `${userId}@example.test`,
    timezone,
    locale: 'en',
    immediate: [],
    digest: ['comment_added'],
    segment: 3,
  };
}

function setup(overrides: Partial<NotifierDigestDeps> = {}) {
  captureOutput();
  const subscriptions = new InMemorySubscriptions();
  const pendingDigest = new InMemoryPendingDigest();
  const deliveries = new InMemoryDeliveriesStore();
  const emailQueue = new MemoryEmailQueue();
  const telemetry = new CountingTelemetry();
  const deps: NotifierDigestDeps = {
    subscriptions,
    pendingDigest,
    deliveries,
    emailQueue,
    log: testLog(),
    telemetry,
    appBaseUrl: 'https://app.example.test',
    segments: 16,
    clock: () => NOW,
    ...overrides,
  };
  const pending = async (
    userId: string,
    category: Category,
    entityId: string,
    occurredAt = '2026-10-22T12:00:00Z',
  ) => {
    const requestId = randomUUID();
    await pendingDigest.add({
      userId,
      sk: pendingDigestSortKey(occurredAt, requestId),
      requestId,
      category,
      entityId,
      occurredAt,
      data: {},
      segment: 3,
      expiresAt: 0,
    });
  };
  return {
    deps,
    run: createNotifierDigest(deps),
    subscriptions,
    pendingDigest,
    deliveries,
    emailQueue,
    telemetry,
    pending,
  };
}

describe('notifier-digest', () => {
  it('mails only users whose local time is inside the window, one digest each', async () => {
    const { run, subscriptions, emailQueue, pending } = setup();
    for (const s of [
      sub('u-berlin', 'Europe/Berlin'),
      sub('u-ny', 'America/New_York'),
      sub('u-tokyo', 'Asia/Tokyo'),
    ]) {
      await subscriptions.put(s);
      await pending(s.userId, 'comment_added', 'doc-1');
      await pending(s.userId, 'report_ready', 'rep-1');
    }
    const result = await run({ segment: 3 }, context(300_000));
    expect(result).toMatchObject({
      segment: 3,
      users: 3,
      due: 1,
      queued: 1,
      remaining: 0,
      failed: 0,
    });
    expect(emailQueue.messages).toHaveLength(1);
    const message = EmailMessageSchema.parse(emailQueue.messages[0]);
    expect(message).toMatchObject({
      userId: 'u-berlin',
      kind: 'digest',
      templateId: 'digest',
      category: 'digest',
      deliveryId: digestDeliveryId('u-berlin', '2026-10-23'),
    });
    expect(message.requestIds).toHaveLength(2);
    expect(message.text).toContain('Comments (1)');
    expect(message.text).toContain('Reports (1)');
  });

  it('uses the LOCAL date as the period (Auckland is already on the next day)', async () => {
    const at = new Date('2026-10-22T19:30:00Z'); // 08:30 on the 23rd in Auckland
    const { run, subscriptions, emailQueue, pending } = setup({ clock: () => at });
    await subscriptions.put(sub('u-akl', 'Pacific/Auckland'));
    await pending('u-akl', 'comment_added', 'doc-1');
    await run({ segment: 3 }, context(300_000));
    expect(emailQueue.messages[0]?.deliveryId).toBe(digestDeliveryId('u-akl', '2026-10-23'));
  });

  it('clears the included pending items, so a re-run the same day queues nothing', async () => {
    const { run, subscriptions, emailQueue, pendingDigest, pending } = setup();
    await subscriptions.put(sub('u-berlin', 'Europe/Berlin'));
    await pending('u-berlin', 'comment_added', 'doc-1');
    await run({ segment: 3 }, context(300_000));
    expect((await pendingDigest.listForUser('u-berlin')).items).toHaveLength(0);
    const again = await run({ segment: 3 }, context(300_000));
    expect(again).toMatchObject({ queued: 0, nothingPending: 1 });
    expect(emailQueue.messages).toHaveLength(1);
  });

  it('skips users already delivered today and keeps their new items for tomorrow', async () => {
    const { run, subscriptions, deliveries, emailQueue, pendingDigest, pending } = setup();
    await subscriptions.put(sub('u-berlin', 'Europe/Berlin'));
    await pending('u-berlin', 'comment_added', 'doc-2');
    const id = digestDeliveryId('u-berlin', '2026-10-23');
    deliveries.items.set(id, {
      deliveryId: id,
      status: DeliveryStatus.SENT,
      attempts: 0,
      updatedAt: '',
      expiresAt: 0,
    });
    const result = await run({ segment: 3 }, context(300_000));
    expect(result).toMatchObject({ alreadyDelivered: 1, queued: 0 });
    expect(emailQueue.messages).toHaveLength(0);
    expect((await pendingDigest.listForUser('u-berlin')).items).toHaveLength(1);
  });

  it('due users with nothing pending get no e-mail', async () => {
    const { run, subscriptions, emailQueue } = setup();
    await subscriptions.put(sub('u-berlin', 'Europe/Berlin'));
    expect(await run({ segment: 3 }, context(300_000))).toMatchObject({
      due: 1,
      nothingPending: 1,
    });
    expect(emailQueue.messages).toHaveLength(0);
  });

  it('stops before the deadline and reports how many users remain', async () => {
    let remaining = 100_000;
    const { run, subscriptions, emailQueue, pending } = setup({ concurrency: 1 });
    for (let i = 0; i < 10; i += 1) {
      const userId = `u-${i}`;
      await subscriptions.put(sub(userId, 'Europe/Berlin'));
      await pending(userId, 'comment_added', `doc-${i}`);
    }
    const original = emailQueue.send.bind(emailQueue);
    emailQueue.send = async (message) => {
      remaining -= 20_000;
      await original(message);
    };
    const result = await run(
      { segment: 3 },
      context(() => remaining),
    );
    // 100 -> 80 -> 60 -> 40 -> 20 (< 30 s): four users done, six remain.
    expect(result).toMatchObject({ due: 10, queued: 4, remaining: 6 });
  });

  it('a failing user does not stop the others; the run then fails so the scheduler retries', async () => {
    const { run, subscriptions, emailQueue, pending } = setup();
    for (const userId of ['u-a', 'u-b', 'u-c']) {
      await subscriptions.put(sub(userId, 'Europe/Berlin'));
      await pending(userId, 'comment_added', 'doc-1');
    }
    const original = emailQueue.send.bind(emailQueue);
    emailQueue.send = (message) =>
      message.userId === 'u-b' ? Promise.reject(new Error('sqs down')) : original(message);
    await expect(run({ segment: 3 }, context(300_000))).rejects.toThrow('1 user(s) failed');
    expect(emailQueue.messages.map((m) => m.userId).sort()).toEqual(['u-a', 'u-c']);
  });

  it('respects the concurrency bound', async () => {
    const { run, subscriptions, emailQueue, pending } = setup({ concurrency: 3 });
    for (let i = 0; i < 12; i += 1) {
      await subscriptions.put(sub(`u-${i}`, 'Europe/Berlin'));
      await pending(`u-${i}`, 'comment_added', 'doc');
    }
    let active = 0;
    let peak = 0;
    const original = emailQueue.send.bind(emailQueue);
    emailQueue.send = async (message) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      await original(message);
    };
    await run({ segment: 3 }, context(300_000));
    expect(peak).toBe(3);
    expect(emailQueue.messages).toHaveLength(12);
  });

  it('skips subscriptions with an invalid time zone and counts invalid rows', async () => {
    const { run, subscriptions } = setup();
    await subscriptions.put(sub('u-bad', 'Mars/Base'));
    subscriptions.invalidRows = 2;
    expect(await run({ segment: 3 }, context(300_000))).toMatchObject({
      users: 1,
      due: 0,
      invalidSubscriptions: 2,
    });
  });

  it.each([{}, { segment: 16 }, { segment: -1 }, { segment: '3' }, null])(
    'rejects event %j',
    async (event) => {
      const { run } = setup();
      await expect(run(event, context(300_000))).rejects.toThrow(/invalid digest event/);
    },
  );

  it('splits a digest that would exceed the limits into parts with distinct delivery ids', async () => {
    const { run, subscriptions, pendingDigest, emailQueue, deliveries, pending } = setup();
    await subscriptions.put(sub('u-berlin', 'Europe/Berlin'));
    for (let i = 0; i < 400; i += 1) {
      const requestId = randomUUID();
      await pendingDigest.add({
        userId: 'u-berlin',
        sk: pendingDigestSortKey('2026-10-22T12:00:00Z', requestId),
        requestId,
        category: 'comment_added',
        entityId: `doc-${String(i)}`,
        occurredAt: '2026-10-22T12:00:00Z',
        data: { subject: 's'.repeat(2000) },
        segment: 3,
        expiresAt: 0,
      });
    }
    const result = await run({ segment: 3 }, context(300_000));
    expect(result).toMatchObject({ queued: 1 });

    const parts = emailQueue.messages;
    expect(parts.length).toBeGreaterThan(1);
    const total = parts.length;
    expect(parts.map((m) => m.deliveryId)).toEqual(
      parts.map((_, i) => digestDeliveryId('u-berlin', '2026-10-23', { index: i + 1, total })),
    );
    expect(new Set(parts.map((m) => m.deliveryId)).size).toBe(total);
    for (const [i, message] of parts.entries()) {
      expect(EmailMessageSchema.parse(message)).toBeTruthy();
      expect(
        messageLimitViolation(message, Buffer.byteLength(JSON.stringify(message))),
      ).toBeUndefined();
      expect(message.subject).toContain(`(part ${String(i + 1)}/${String(total)})`);
      expect(message.text).not.toMatch(/...and d+ more/);
    }
    // Every item is in exactly one part.
    const ids = parts.flatMap((m) => m.requestIds);
    expect(ids).toHaveLength(400);
    expect(new Set(ids).size).toBe(400);

    // Once part 1 is delivered, the day counts as delivered.
    const first = parts[0]?.deliveryId ?? '';
    deliveries.items.set(first, {
      deliveryId: first,
      status: DeliveryStatus.SENT,
      attempts: 0,
      updatedAt: '',
      expiresAt: 0,
    });
    await pending('u-berlin', 'comment_added', 'late-doc');
    expect(await run({ segment: 3 }, context(300_000))).toMatchObject({
      alreadyDelivered: 1,
      queued: 0,
    });
  });

  it('a digest that fits stays a single message with the plain local-date id', async () => {
    const { run, subscriptions, emailQueue, pending } = setup();
    await subscriptions.put(sub('u-berlin', 'Europe/Berlin'));
    await pending('u-berlin', 'comment_added', 'doc-1');
    await run({ segment: 3 }, context(300_000));
    expect(emailQueue.messages).toHaveLength(1);
    expect(emailQueue.messages[0]?.deliveryId).toBe(digestDeliveryId('u-berlin', '2026-10-23'));
    expect(emailQueue.messages[0]?.subject).not.toContain('part');
  });

  it('a configurable window (e.g. 0-24 for local demos)', async () => {
    const { run, subscriptions, pending } = setup({ window: { startHour: 0, endHour: 24 } });
    await subscriptions.put(sub('u-tokyo', 'Asia/Tokyo'));
    await pending('u-tokyo', 'comment_added', 'doc');
    expect(await run({ segment: 3 }, context(300_000))).toMatchObject({ due: 1, queued: 1 });
  });
});

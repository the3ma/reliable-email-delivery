import { describe, expect, it } from 'vitest';
import { DeliveryStatus, digestDeliveryId, emailHash } from '@mail/core';
import { seedSubscription } from '@mail/functions';
import { call, world } from './fakes.js';

async function seed(w: ReturnType<typeof world>) {
  expect((await call(w.app, 'POST', '/reset', {})).status).toBe(200);
}

function statuses(w: ReturnType<typeof world>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of w.deliveries.items.values()) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

describe('GET /scenarios', () => {
  it('lists exactly the 8 contract scenarios', async () => {
    const w = world();
    const { status, json } = await call(w.app, 'GET', '/scenarios');
    expect(status).toBe(200);
    expect((json as { id: string }[]).map((s) => s.id)).toEqual([
      'burst',
      'duplicate-storm',
      'invalid',
      'suppressed',
      'digest',
      'big-digest',
      'kill-switch',
      'bounce',
    ]);
    for (const s of json as Record<string, unknown>[]) {
      expect(Object.keys(s).sort()).toEqual(['description', 'expected', 'id', 'title']);
    }
  });

  it('unknown scenario -> 404 error shape', async () => {
    const w = world();
    const { status, json } = await call(w.app, 'POST', '/scenarios/nope/run', {});
    expect(status).toBe(404);
    expect(json).toEqual({ error: { code: 'not_found', message: 'unknown scenario nope' } });
  });
});

describe('scenarios through the real notifier + processor logic', () => {
  it('duplicate-storm: 120 concurrent copies of 10 notifications -> exactly 10 sends', async () => {
    const w = world();
    await seed(w);
    const { status, json } = await call(w.app, 'POST', '/scenarios/duplicate-storm/run', {});
    expect(status).toBe(202);
    expect(json).toMatchObject({ published: 120 });
    expect((json as { runId: string }).runId).toMatch(/^[0-9a-f-]{36}$/);

    expect(w.pipeline.transport.sent).toHaveLength(10);
    expect(new Set(w.pipeline.transport.sent.map((e) => e.tags.deliveryId)).size).toBe(10);
    expect(statuses(w)).toEqual({ SENT: 10 });
    // Every copy that reached the processor after the first send was dropped as a duplicate.
    expect(
      w.pipeline.telemetry.get('DuplicatesSuppressed') +
        w.pipeline.telemetry.get('ClaimContention'),
    ).toBeGreaterThan(0);
    expect(w.mail.mails).toHaveLength(10);
  });

  it('burst: 50 requests for 20 users -> 50 e-mails, one per delivery id', async () => {
    const w = world();
    await seed(w);
    const { json } = await call(w.app, 'POST', '/scenarios/burst/run', {});
    expect(json).toMatchObject({ published: 50 });
    expect(w.pipeline.transport.sent).toHaveLength(50);
    expect(new Set(w.pipeline.transport.sent.map((e) => e.to)).size).toBe(20);
    expect(statuses(w)).toEqual({ SENT: 50 });
  });

  it('invalid: 5 malformed messages -> 0 e-mails, nothing left to retry', async () => {
    const w = world();
    await seed(w);
    const { json } = await call(w.app, 'POST', '/scenarios/invalid/run', {});
    expect(json).toMatchObject({ published: 5 });
    expect(w.pipeline.transport.sent).toHaveLength(0);
    expect(w.pipeline.intake).toHaveLength(0);
    expect(w.pipeline.rawEmail).toHaveLength(0);
    expect(w.pipeline.telemetry.get('InvalidMessages')).toBe(5);
    // The oversized one is the only one with a delivery id.
    expect([...w.deliveries.items.values()].map((r) => r.reason)).toEqual([
      'invalid:html_too_large',
    ]);
  });

  it('suppressed: pre-suppressed seed users -> 0 e-mails, SKIPPED(suppressed)', async () => {
    const w = world();
    await seed(w);
    const { json } = await call(w.app, 'POST', '/scenarios/suppressed/run', {});
    expect(json).toMatchObject({ published: 4 });
    expect(w.pipeline.transport.sent).toHaveLength(0);
    expect([...w.deliveries.items.values()].every((r) => r.reason === 'suppressed')).toBe(true);
    expect(statuses(w)).toEqual({ SKIPPED: 4 });
  });

  it('digest: one digest per user; a second run sends 0', async () => {
    const w = world();
    await seed(w);
    const { json } = await call(w.app, 'POST', '/scenarios/digest/run', {});
    expect(json).toMatchObject({ published: 10 });
    await w.pipeline.drain();
    expect(w.pipeline.transport.sent).toHaveLength(10);
    expect(w.pipeline.transport.sent.every((e) => e.subject.startsWith('Your daily summary'))).toBe(
      true,
    );

    const again = await call(w.app, 'POST', '/digest/run', { all: true, ignoreWindow: true });
    expect(again.json).toMatchObject({ queued: 0, parts: 0 });
    await w.pipeline.drain();
    expect(w.pipeline.transport.sent).toHaveLength(10);
  });

  it('big-digest: arrives in parts, each its own delivery id', async () => {
    const w = world();
    await seed(w);
    const { json } = await call(w.app, 'POST', '/scenarios/big-digest/run', {});
    const parts = (json as { published: number }).published;
    expect(parts).toBeGreaterThan(1);
    await w.pipeline.drain();
    const sent = w.pipeline.transport.sent;
    expect(sent).toHaveLength(parts);
    expect(new Set(sent.map((e) => e.tags.deliveryId)).size).toBe(parts);
    const userId = [...w.subscriptions.items.keys()].find((id) => id.startsWith('u-big-')) ?? '';
    const ids = Array.from({ length: parts }, (_, i) =>
      digestDeliveryId(userId, '2026-10-23', { index: i + 1, total: parts }),
    );
    expect(sent.map((e) => e.tags.deliveryId).sort()).toEqual([...ids].sort());
    for (const e of sent) expect(e.subject).toMatch(/\(part \d+\/\d+\)$/);
  });

  it('kill-switch: 0 e-mails, 10 SKIPPED(disabled), toggle restored', async () => {
    const w = world();
    await seed(w);
    const { json } = await call(w.app, 'POST', '/scenarios/kill-switch/run', {});
    expect(json).toMatchObject({ published: 10 });
    // A second background run is refused while this one holds the shared toggle.
    expect((await call(w.app, 'POST', '/scenarios/bounce/run', {})).status).toBe(409);
    await w.scenarios.pending;
    expect(w.pipeline.transport.sent).toHaveLength(0);
    expect(statuses(w)).toEqual({ SKIPPED: 10 });
    expect([...w.deliveries.items.values()].every((r) => r.reason === 'disabled')).toBe(true);
    expect(w.toggles.history).toEqual(['disabled', 'enabled']);
    expect(w.toggles.values.sendEmails).toBe('enabled');
    const run = await call(w.app, 'GET', `/scenarios/runs/${(json as { runId: string }).runId}`);
    expect(run.json).toMatchObject({ status: 'done', scenario: 'kill-switch' });
  });

  it('kill-switch restores the toggle even when publishing fails', async () => {
    const w = world();
    await seed(w);
    w.pipeline.putEvents = () => Promise.reject(new Error('eventbridge down'));
    const { json } = await call(w.app, 'POST', '/scenarios/kill-switch/run', {});
    await w.scenarios.pending;
    expect(w.toggles.values.sendEmails).toBe('enabled');
    const run = await call(w.app, 'GET', `/scenarios/runs/${(json as { runId: string }).runId}`);
    expect(run.json).toMatchObject({ status: 'failed' });
  });

  it('bounce: first delivered, address suppressed, second SKIPPED(suppressed)', async () => {
    const w = world();
    await seed(w);
    await call(w.app, 'POST', '/scenarios/bounce/run', {});
    await w.scenarios.pending;
    expect(w.pipeline.transport.sent).toHaveLength(1);
    const to = w.pipeline.transport.sent[0]?.to ?? '';
    expect(w.suppressions.items.get(emailHash(to))).toMatchObject({ reason: 'bounce_permanent' });
    const records = [...w.deliveries.items.values()].sort((a, b) =>
      a.status.localeCompare(b.status),
    );
    expect(records.map((r) => [r.status, r.reason])).toEqual([
      [DeliveryStatus.SENT, undefined],
      [DeliveryStatus.SKIPPED, 'suppressed'],
    ]);
    // The bounce event is in the first delivery's log (via its deliveryId tag).
    const first = records[0]?.deliveryId ?? '';
    expect(w.deliveryLog.events(first)).toContain('bounced');
  });

  it('scenarios run without a prior reset (they upsert the seed users they need)', async () => {
    const w = world();
    await call(w.app, 'POST', '/scenarios/burst/run', {});
    expect(w.pipeline.transport.sent).toHaveLength(50);
    expect(w.subscriptions.items.has(seedSubscription(3, 16).userId)).toBe(true);
  });
});

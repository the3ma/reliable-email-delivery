import { describe, expect, it } from 'vitest';
import { emailHash } from '@mail/core';
import { toggleCacheTtlSeconds } from '@mail/functions';
import { ConfigError, loadConfig } from '../src/config.js';
import { call, world } from './fakes.js';

type Json = Record<string, unknown>;
const RAW_ADDRESS = /[A-Za-z0-9._%+-]{2,}@example\.test/;

async function seededWithMail() {
  const w = world();
  await call(w.app, 'POST', '/reset', {});
  await call(w.app, 'POST', '/scenarios/burst/run', {});
  return w;
}

describe('config', () => {
  it('refuses to start without AWS_ENDPOINT_URL', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ AWS_ENDPOINT_URL: '' })).toThrow(/local stack/);
  });

  it('refuses a real AWS endpoint', () => {
    expect(() =>
      loadConfig({ AWS_ENDPOINT_URL: 'https://dynamodb.us-east-1.amazonaws.com' }),
    ).toThrow(/local only/);
  });

  it('defaults: port 3001, Mailpit on 8025, web origin 8080', () => {
    expect(loadConfig({ AWS_ENDPOINT_URL: 'http://localstack:4566' })).toMatchObject({
      port: 3001,
      mailpitUrl: 'http://localhost:8025',
      webOrigin: 'http://localhost:8080',
      ssmPrefix: '/local/email/',
      segments: 16,
      workerToggleTtlSeconds: 300,
    });
  });

  it('TOGGLE_CACHE_TTL_SECONDS is a supported setting of the functions (default 300)', () => {
    expect(toggleCacheTtlSeconds({})).toBe(300);
    expect(toggleCacheTtlSeconds({ TOGGLE_CACHE_TTL_SECONDS: '5' })).toBe(5);
    expect(() => toggleCacheTtlSeconds({ TOGGLE_CACHE_TTL_SECONDS: '-1' })).toThrow();
    expect(() => toggleCacheTtlSeconds({ TOGGLE_CACHE_TTL_SECONDS: 'soon' })).toThrow();
  });
});

describe('errors and CORS', () => {
  it('unknown routes use the error shape', async () => {
    const w = world();
    expect(await call(w.app, 'GET', '/nope')).toEqual({
      status: 404,
      json: { error: { code: 'not_found', message: 'no such endpoint' } },
    });
  });

  it('invalid JSON bodies are 400 invalid_json', async () => {
    const w = world();
    const { status, json } = await call(w.app, 'POST', '/feedback', '{not json');
    expect(status).toBe(400);
    expect((json as { error: Json }).error.code).toBe('invalid_json');
  });

  it('internal errors are 500 without leaking details', async () => {
    const w = world();
    w.deps.deliveriesAdmin.list = () =>
      Promise.reject(new Error('dynamo exploded for ada@example.test'));
    const { status, json } = await call(w.app, 'GET', '/overview');
    expect(status).toBe(500);
    expect(JSON.stringify(json)).not.toContain('ada@example.test');
  });

  it('CORS allows only the web origin', async () => {
    const w = world();
    const allowed = await w.app.request('/api/v1/toggles', {
      headers: { origin: 'http://localhost:8080' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:8080');
    const other = await w.app.request('/api/v1/toggles', {
      headers: { origin: 'http://evil.example.test' },
    });
    expect(other.headers.get('access-control-allow-origin')).not.toBe('http://evil.example.test');
  });
});

describe('GET /health', () => {
  it('ok when LocalStack and Mailpit answer', async () => {
    const w = world();
    expect(await call(w.app, 'GET', '/health')).toEqual({
      status: 200,
      json: { status: 'ok', checks: { localstack: 'ok', mailpit: 'ok' } },
    });
  });

  it('503 degraded when one is down', async () => {
    const w = world();
    w.mail.up = false;
    expect(await call(w.app, 'GET', '/health')).toEqual({
      status: 503,
      json: { status: 'degraded', checks: { localstack: 'ok', mailpit: 'down' } },
    });
  });
});

describe('GET /overview', () => {
  it('counts by status and skip reason, queues, toggles and totals', async () => {
    const w = await seededWithMail();
    await call(w.app, 'POST', '/scenarios/suppressed/run', {});
    const { status, json } = await call(w.app, 'GET', '/overview');
    expect(status).toBe(200);
    expect(json).toEqual({
      counts: { CLAIMED: 0, SENT: 50, FAILED_PERMANENT: 0, RELEASED: 0, AMBIGUOUS: 0, SKIPPED: 4 },
      skippedByReason: { suppressed: 4 },
      queues: w.queues.depthsValue,
      toggles: { sendEmails: 'enabled', recordDeliveries: 'enabled' },
      mail: { total: 50 },
      suppressions: { total: 4 },
      subscriptions: { total: 40 },
    });
  });
});

describe('GET /deliveries', () => {
  it('lists newest first with masked recipients, never raw addresses', async () => {
    const w = await seededWithMail();
    const { status, json } = await call(w.app, 'GET', '/deliveries?limit=5');
    expect(status).toBe(200);
    const body = json as { items: Json[]; nextCursor: string | null };
    expect(body.items).toHaveLength(5);
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(
      [
        'attempts',
        'category',
        'deliveryId',
        'kind',
        'status',
        'toMasked',
        'updatedAt',
        'userId',
      ].sort(),
    );
    expect(body.items[0]).toMatchObject({
      status: 'SENT',
      category: 'report_ready',
      kind: 'immediate',
    });
    expect(String(body.items[0]?.toMasked)).toMatch(/^u\*\*\*@example\.test$/);
    expect(JSON.stringify(json)).not.toMatch(RAW_ADDRESS);
    expect(body.nextCursor).toEqual(expect.any(String));
  });

  it('paginates with an opaque cursor without overlap or gaps', async () => {
    const w = await seededWithMail();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const path = `/deliveries?limit=7${cursor ? `&cursor=${cursor}` : ''}`;
      const body = (await call(w.app, 'GET', path)).json as {
        items: Json[];
        nextCursor: string | null;
      };
      seen.push(...body.items.map((i) => String(i.deliveryId)));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(50);
    expect(new Set(seen).size).toBe(50);
  });

  it('filters by status, category and kind', async () => {
    const w = await seededWithMail();
    await call(w.app, 'POST', '/scenarios/suppressed/run', {});
    const skipped = (await call(w.app, 'GET', '/deliveries?status=SKIPPED')).json as {
      items: Json[];
    };
    expect(skipped.items).toHaveLength(4);
    expect(skipped.items.every((i) => i.reason === 'suppressed')).toBe(true);
    const digest = (await call(w.app, 'GET', '/deliveries?kind=digest')).json as { items: Json[] };
    expect(digest.items).toHaveLength(0);
    const reports = (await call(w.app, 'GET', '/deliveries?category=report_ready&limit=200'))
      .json as { items: Json[] };
    expect(reports.items).toHaveLength(54);
  });

  it.each(['limit=0', 'limit=201', 'status=DONE', 'kind=weekly', 'cursor=%%%'])(
    'rejects %s',
    async (q) => {
      const w = world();
      expect((await call(w.app, 'GET', `/deliveries?${q}`)).status).toBe(400);
    },
  );
});

describe('GET /deliveries/{id}', () => {
  it('returns the item, its redacted event timeline and the Mailpit id', async () => {
    const w = await seededWithMail();
    const first = [...w.deliveries.items.values()][0];
    const { status, json } = await call(w.app, 'GET', `/deliveries/${first?.deliveryId ?? ''}`);
    expect(status).toBe(200);
    const body = json as Json & { events: Json[] };
    expect(body).toMatchObject({ deliveryId: first?.deliveryId, status: 'SENT' });
    expect(body.events.map((e) => e.event)).toEqual(['claimed', 'sent']);
    expect(body.mailId).toMatch(/^mp-\d+$/);
    expect(JSON.stringify(json)).not.toMatch(RAW_ADDRESS);
  });

  it('404 for an unknown id', async () => {
    const w = world();
    expect((await call(w.app, 'GET', '/deliveries/abc')).status).toBe(404);
  });
});

describe('GET /suppressions', () => {
  it('shows the hash only', async () => {
    const w = world();
    await call(w.app, 'POST', '/reset', {});
    const { json } = await call(w.app, 'GET', '/suppressions');
    const body = json as { items: Json[]; nextCursor: null };
    expect(body.nextCursor).toBeNull();
    expect(body.items).toHaveLength(4);
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
      'createdAt',
      'emailHash',
      'lastEventAt',
      'reason',
      'source',
    ]);
    expect(JSON.stringify(json)).not.toContain('@');
  });
});

describe('POST /feedback', () => {
  it('a permanent bounce suppresses the address', async () => {
    const w = world();
    const { status, json } = await call(w.app, 'POST', '/feedback', {
      type: 'bounce',
      email: 'someone@example.test',
    });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, suppressed: 1 });
    expect(w.suppressions.items.get(emailHash('someone@example.test'))).toMatchObject({
      reason: 'bounce_permanent',
    });
  });

  it('a transient bounce and a delivery suppress nothing', async () => {
    const w = world();
    expect(
      (
        await call(w.app, 'POST', '/feedback', {
          type: 'bounce',
          email: 'a1@example.test',
          transient: true,
        })
      ).json,
    ).toEqual({
      ok: true,
      suppressed: 0,
    });
    expect(
      (await call(w.app, 'POST', '/feedback', { type: 'delivery', email: 'a1@example.test' })).json,
    ).toEqual({
      ok: true,
      suppressed: 0,
    });
  });

  it('complaints suppress', async () => {
    const w = world();
    expect(
      (await call(w.app, 'POST', '/feedback', { type: 'complaint', email: 'c@example.test' })).json,
    ).toEqual({
      ok: true,
      suppressed: 1,
    });
  });

  it.each([
    { type: 'bounce', email: 'real@example.com' },
    { type: 'reject', email: 'a@example.test' },
    { type: 'bounce', email: 'not-an-address' },
    { type: 'bounce' },
  ])('rejects %j', async (input) => {
    const w = world();
    const { status, json } = await call(w.app, 'POST', '/feedback', input);
    expect(status).toBe(400);
    expect((json as { error: Json }).error.code).toBe('invalid_request');
  });
});

describe('toggles', () => {
  it('GET reads, PUT writes send-emails', async () => {
    const w = world();
    expect((await call(w.app, 'GET', '/toggles')).json).toEqual({
      sendEmails: 'enabled',
      recordDeliveries: 'enabled',
    });
    const { status, json } = await call(w.app, 'PUT', '/toggles/send-emails', {
      value: 'disabled',
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ value: 'disabled' });
    expect(String((json as Json).note)).toContain('5 s');
    expect(w.toggles.values.sendEmails).toBe('disabled');
  });

  it('rejects other values', async () => {
    const w = world();
    expect((await call(w.app, 'PUT', '/toggles/send-emails', { value: 'off' })).status).toBe(400);
  });
});

describe('POST /digest/run', () => {
  it.each([{}, { segment: 3, all: true }, { segment: 16 }, { segment: -1 }, { all: false }])(
    'rejects %j',
    async (input) => {
      const w = world();
      expect((await call(w.app, 'POST', '/digest/run', input)).status).toBe(400);
    },
  );

  it('respects the local window unless ignoreWindow is set', async () => {
    const w = world();
    await call(w.app, 'POST', '/reset', {});
    await call(w.app, 'POST', '/scenarios/digest/run', {}); // queues and sends 10 digests
    const second = await call(w.app, 'POST', '/digest/run', { all: true });
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ queued: 0, parts: 0 });
    expect(typeof (second.json as Json).users).toBe('number');
    expect(Object.keys(second.json as Json)).toEqual(
      expect.arrayContaining(['users', 'queued', 'alreadyDelivered', 'parts']),
    );
  });
});

describe('POST /reset', () => {
  it('clears state, keeps seeded suppressions, purges queues and Mailpit, re-seeds', async () => {
    const w = await seededWithMail();
    await call(w.app, 'POST', '/feedback', { type: 'complaint', email: 'x1@example.test' });
    expect(w.suppressions.items.size).toBe(5);
    const { status, json } = await call(w.app, 'POST', '/reset', {});
    expect(status).toBe(200);
    expect(json).toMatchObject({
      cleared: { deliveries: 50, suppressions: 1, mail: true, queues: true },
      seeded: { users: 40, suppressed: 4 },
    });
    expect(w.deliveries.items.size).toBe(0);
    expect(w.deliveryLog.items).toHaveLength(0);
    expect(w.mail.mails).toHaveLength(0);
    expect(w.suppressions.items.size).toBe(4);
    expect(w.subscriptions.items.size).toBe(40);
    expect(w.queues.purged).toBe(2);
  });
});

describe('Mailbox (Mailpit proxy)', () => {
  it('lists mail with the unmasked local address, deliveryId and category from the X-Tag headers', async () => {
    const w = await seededWithMail();
    const { json } = await call(w.app, 'GET', '/mail?limit=10');
    const body = json as { items: Json[]; nextCursor: string | null };
    expect(body.items).toHaveLength(10);
    expect(body.nextCursor).toBe('10');
    const item = body.items[0] ?? {};
    expect(Object.keys(item).sort()).toEqual([
      'category',
      'createdAt',
      'deliveryId',
      'id',
      'size',
      'subject',
      'to',
    ]);
    expect(String(item.to)).toMatch(/^user-\d{3}@example\.test$/);
    expect(item.category).toBe('report_ready');
    expect(w.deliveries.items.has(String(item.deliveryId))).toBe(true);

    const last = (await call(w.app, 'GET', '/mail?limit=10&cursor=40')).json as {
      nextCursor: string | null;
    };
    expect(last.nextCursor).toBeNull();
  });

  it('GET /mail/{id} returns bodies and headers; 404 when unknown', async () => {
    const w = await seededWithMail();
    const id = w.mail.mails[0]?.message.id ?? '';
    const { status, json } = await call(w.app, 'GET', `/mail/${id}`);
    expect(status).toBe(200);
    expect(json).toMatchObject({ id, from: 'notifications@example.test' });
    const body = json as Json & { headers: Record<string, string[]> };
    expect(String(body.html)).toContain('<');
    expect(String(body.text).length).toBeGreaterThan(0);
    expect(body.deliveryId).toMatch(/^[0-9a-f]{64}$/);
    expect(body.headers['X-Tag-Deliveryid']).toBeDefined();
    expect((await call(w.app, 'GET', '/mail/missing')).status).toBe(404);
  });
});

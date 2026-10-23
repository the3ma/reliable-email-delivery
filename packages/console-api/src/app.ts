import { DeliveryStatus, redact } from '@mail/core';
import type { DeliveryRecord } from '@mail/core';
import {
  createFeedback,
  createNotifierDigest,
  runDigestSegments,
  seedUsers,
  simulateFeedback,
} from '@mail/functions';
import type { Telemetry } from '@mail/functions';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { header } from './aws/mailpit.js';
import type { ConsoleDeps } from './ports.js';
import { SCENARIOS, ScenarioRunner } from './scenarios.js';

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The console runs the handlers' logic in-process; their counters only matter in Lambda. */
const noTelemetry: Telemetry = {
  count: () => undefined,
  flush: () => undefined,
};

const STATUSES = Object.values(DeliveryStatus);

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'cursor is not valid');
  }
}

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map(String).join('.') ?? '';
    throw new HttpError(
      400,
      'invalid_request',
      `${path === '' ? 'body' : path}: ${issue?.message ?? 'invalid'}`,
    );
  }
  return parsed.data;
}

function query<T>(c: Context, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(
      400,
      'invalid_query',
      `${issue?.path.map(String).join('.') ?? 'query'}: ${issue?.message ?? 'invalid'}`,
    );
  }
  return parsed.data;
}

const Limit = z.coerce.number().int().min(1).max(200).default(50);
const DeliveryCursor = z.object({ u: z.string(), d: z.string() });

/** Newest first; ties broken by id so the order (and therefore the cursor) is stable. */
function byNewest(a: DeliveryRecord, b: DeliveryRecord): number {
  return b.updatedAt.localeCompare(a.updatedAt) || b.deliveryId.localeCompare(a.deliveryId);
}

function deliveryView(record: DeliveryRecord) {
  return {
    deliveryId: record.deliveryId,
    status: record.status,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    category: record.category ?? null,
    kind: record.kind ?? null,
    userId: record.userId ?? null,
    toMasked: record.toMasked ?? null,
    attempts: record.attempts,
    updatedAt: record.updatedAt,
  };
}

function stripBrackets(messageId: string): string {
  return messageId.replace(/^<|>$/g, '');
}

export function createApp(deps: ConsoleDeps) {
  const { config, log } = deps;

  const feedback = createFeedback({
    suppressions: deps.suppressions,
    deliveryLog: deps.deliveryLog,
    log,
    telemetry: noTelemetry,
    ...(deps.clock ? { clock: deps.clock } : {}),
  });

  async function runDigest(options: { segments: number[]; ignoreWindow: boolean }) {
    const notifier = createNotifierDigest({
      subscriptions: deps.subscriptions,
      pendingDigest: deps.pendingDigest,
      deliveries: deps.deliveries,
      emailQueue: deps.emailQueue,
      log,
      telemetry: noTelemetry,
      appBaseUrl: config.appBaseUrl,
      segments: config.segments,
      window: options.ignoreWindow ? { startHour: 0, endHour: 24 } : config.digestWindow,
      ...(deps.clock ? { clock: deps.clock } : {}),
    });
    return runDigestSegments(notifier, options.segments);
  }

  const scenarios = new ScenarioRunner(deps, {
    runDigest: async (options) => {
      const { totals } = await runDigest(options);
      return { messages: totals.messages, queued: totals.queued };
    },
    feedback: async (options) => {
      const result = await simulateFeedback(feedback, options);
      return { suppressed: result?.suppressed ?? 0 };
    },
  });

  const app = new Hono();
  app.use(
    '/api/*',
    cors({ origin: config.webOrigin, allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'] }),
  );

  const api = new Hono();

  api.get('/health', async (c) => {
    const [localstack, mailpit] = await Promise.all([
      deps.localstackPing().catch(() => false),
      deps.mail.ping().catch(() => false),
    ]);
    const healthy = localstack && mailpit;
    return c.json(
      {
        status: healthy ? 'ok' : 'degraded',
        checks: { localstack: localstack ? 'ok' : 'down', mailpit: mailpit ? 'ok' : 'down' },
      },
      healthy ? 200 : 503,
    );
  });

  api.get('/overview', async (c) => {
    const [deliveries, queues, toggles, mail, suppressions, subscriptions] = await Promise.all([
      deps.deliveriesAdmin.list(),
      deps.queues.depths(),
      deps.toggles.get(),
      deps.mail.list(0, 1),
      deps.suppressionsAdmin.list(),
      deps.subscriptionsAdmin.count(),
    ]);
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<
      string,
      number
    >;
    const skippedByReason: Record<string, number> = {};
    for (const record of deliveries) {
      counts[record.status] = (counts[record.status] ?? 0) + 1;
      if (record.status === DeliveryStatus.SKIPPED) {
        const reason = record.reason ?? 'unknown';
        skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
      }
    }
    return c.json({
      counts,
      skippedByReason,
      queues,
      toggles,
      mail: { total: mail.total },
      suppressions: { total: suppressions.length },
      subscriptions: { total: subscriptions },
    });
  });

  api.get('/scenarios', (c) => c.json(SCENARIOS));

  api.post('/scenarios/:id/run', async (c) => {
    const id = c.req.param('id');
    if (!SCENARIOS.some((scenario) => scenario.id === id)) {
      throw new HttpError(404, 'not_found', `unknown scenario ${id}`);
    }
    await body(c, z.object({}).loose());
    const busy = scenarios.busyWith;
    if (busy) {
      throw new HttpError(409, 'run_in_progress', `scenario run ${busy} is still in progress`);
    }
    const run = await scenarios.run(id);
    return c.json(
      { runId: run.runId, startedAt: run.startedAt, published: run.published, notes: run.notes },
      202,
    );
  });

  api.get('/scenarios/runs/:runId', (c) => {
    const run = scenarios.get(c.req.param('runId'));
    if (!run) throw new HttpError(404, 'not_found', 'unknown run');
    return c.json(run);
  });

  api.get('/deliveries', async (c) => {
    const q = query(
      c,
      z.object({
        status: z.enum(STATUSES).optional(),
        category: z.string().min(1).optional(),
        kind: z.enum(['immediate', 'digest']).optional(),
        limit: Limit,
        cursor: z.string().optional(),
      }),
    );
    let records = (await deps.deliveriesAdmin.list())
      .filter((r) => q.status === undefined || r.status === q.status)
      .filter((r) => q.category === undefined || r.category === q.category)
      .filter((r) => q.kind === undefined || r.kind === q.kind)
      .sort(byNewest);
    if (q.cursor !== undefined) {
      const after = decodeCursor(q.cursor, DeliveryCursor);
      const anchor = { updatedAt: after.u, deliveryId: after.d } as DeliveryRecord;
      records = records.filter((r) => byNewest(anchor, r) < 0);
    }
    const page = records.slice(0, q.limit);
    const last = page.at(-1);
    return c.json({
      items: page.map(deliveryView),
      nextCursor:
        records.length > q.limit && last
          ? encodeCursor({ u: last.updatedAt, d: last.deliveryId })
          : null,
    });
  });

  api.get('/deliveries/:id', async (c) => {
    const id = c.req.param('id');
    const record = await deps.deliveries.get(id);
    if (!record) throw new HttpError(404, 'not_found', 'unknown delivery');
    const events = (await deps.deliveryLogAdmin.events(id))
      .sort((a, b) => a.sk.localeCompare(b.sk))
      .map((item) => ({ at: item.at, event: item.event, details: redact(item.details) }));
    let mailId: string | undefined;
    if (record.sesMessageId) {
      mailId = await deps.mail
        .findByMessageId(stripBrackets(record.sesMessageId))
        .catch(() => undefined);
    }
    return c.json({ ...deliveryView(record), events, ...(mailId ? { mailId } : {}) });
  });

  api.get('/suppressions', async (c) => {
    const items = (await deps.suppressionsAdmin.list()).sort((a, b) =>
      b.lastEventAt.localeCompare(a.lastEventAt),
    );
    return c.json({ items, nextCursor: null });
  });

  api.post('/feedback', async (c) => {
    const input = await body(
      c,
      z.object({
        type: z.enum(['bounce', 'complaint', 'delivery']),
        email: z
          .email()
          .refine(
            (email) => email.toLowerCase().endsWith('@example.test'),
            'only fake @example.test addresses',
          ),
        transient: z.boolean().optional(),
      }),
    );
    const result = await simulateFeedback(feedback, input);
    return c.json({ ok: true, suppressed: result?.suppressed ?? 0 });
  });

  api.get('/toggles', async (c) => c.json(await deps.toggles.get()));

  api.put('/toggles/send-emails', async (c) => {
    const { value } = await body(c, z.object({ value: z.enum(['enabled', 'disabled']) }));
    await deps.toggles.setSendEmails(value);
    log.info('send-emails toggle changed', { value });
    return c.json({
      value,
      note: `the processor picks it up within its cache TTL (${String(config.workerToggleTtlSeconds)} s, TOGGLE_CACHE_TTL_SECONDS)`,
    });
  });

  api.post('/digest/run', async (c) => {
    const input = await body(
      c,
      z
        .object({
          segment: z
            .number()
            .int()
            .min(0)
            .max(config.segments - 1)
            .optional(),
          all: z.literal(true).optional(),
          ignoreWindow: z.boolean().optional(),
        })
        .refine(
          (v) => (v.segment === undefined) !== (v.all === undefined),
          'give exactly one of segment or all',
        ),
    );
    const segments = input.all
      ? Array.from({ length: config.segments }, (_, i) => i)
      : [input.segment ?? 0];
    const { totals, failures } = await runDigest({
      segments,
      ignoreWindow: input.ignoreWindow === true,
    });
    return c.json({
      users: totals.users,
      due: totals.due,
      queued: totals.queued,
      alreadyDelivered: totals.alreadyDelivered,
      nothingPending: totals.nothingPending,
      parts: totals.messages,
      remaining: totals.remaining,
      failed: totals.failed,
      failures,
    });
  });

  api.post('/reset', async (c) => {
    await body(c, z.object({}).loose());
    if (scenarios.busyWith)
      throw new HttpError(409, 'run_in_progress', 'a scenario run is in progress');
    const [deliveries, deliveryLog, pendingDigest, suppressions] = await Promise.all([
      deps.deliveriesAdmin.clear(),
      deps.deliveryLogAdmin.clear(),
      deps.pendingDigestAdmin.clear(),
      deps.suppressionsAdmin.clear((record) => record.source === 'seed'),
    ]);
    await deps.queues.purgeAll();
    await deps.mail.deleteAll();
    const subscriptions = await deps.subscriptionsAdmin.clear();
    const seeded = await seedUsers({
      subscriptions: deps.subscriptions,
      suppressions: deps.suppressions,
      users: config.seed.users,
      suppressEvery: config.seed.suppressEvery,
      segments: config.segments,
    });
    log.info('reset done', { deliveries, deliveryLog, pendingDigest, suppressions, subscriptions });
    return c.json({
      cleared: {
        deliveries,
        deliveryLog,
        pendingDigest,
        suppressions,
        subscriptions,
        mail: true,
        queues: true,
      },
      seeded,
    });
  });

  api.get('/mail', async (c) => {
    const q = query(c, z.object({ limit: Limit, cursor: z.string().regex(/^\d+$/).optional() }));
    const start = q.cursor === undefined ? 0 : Number(q.cursor);
    const { total, messages } = await deps.mail.list(start, q.limit);
    const items = await mapLimited(messages, 8, async (message) => {
      const headers = await deps.mail.headers(message.id).catch(() => undefined);
      const deliveryId = header(headers, 'X-Tag-deliveryId');
      const category = header(headers, 'X-Tag-category');
      return {
        id: message.id,
        to: message.to.join(', '),
        subject: message.subject,
        createdAt: message.createdAt,
        ...(deliveryId ? { deliveryId } : {}),
        ...(category ? { category } : {}),
        size: message.size,
      };
    });
    return c.json({
      items,
      nextCursor: start + messages.length < total ? String(start + messages.length) : null,
    });
  });

  api.get('/mail/:id', async (c) => {
    const id = c.req.param('id');
    const [message, headers] = await Promise.all([deps.mail.get(id), deps.mail.headers(id)]);
    if (!message) throw new HttpError(404, 'not_found', 'unknown message');
    const deliveryId = header(headers, 'X-Tag-deliveryId');
    return c.json({
      id: message.id,
      to: message.to.join(', '),
      from: message.from,
      subject: message.subject,
      createdAt: message.createdAt,
      text: message.text,
      html: message.html,
      headers: headers ?? {},
      ...(deliveryId ? { deliveryId } : {}),
    });
  });

  app.route('/api/v1', api);

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'no such endpoint' } }, 404));
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    log.error('request failed', error, { path: c.req.path });
    return c.json(
      { error: { code: 'internal', message: 'internal error (see console-api logs)' } },
      500,
    );
  });

  return { app, scenarios };
}

async function mapLimited<T, R>(
  values: readonly T[],
  limit: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      out[index] = await fn(values[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return out;
}

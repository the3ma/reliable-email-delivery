import { http, HttpResponse } from 'msw';
import { DELIVERY_STATUSES } from '../api/types';
import type { DeliverySummary, FeedbackRequest, MailSummary, ToggleValue } from '../api/types';
import { db, SCENARIOS } from './db';

const API = '*/api/v1';

function apiError(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status });
}

function paginate<T>(items: readonly T[], url: URL) {
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && !/^\d+$/.test(cursor)) return undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get('cursor') ?? 0) || 0, 0);
  const page = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? String(offset + limit) : null;
  return { items: page, nextCursor: next };
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const handlers = [
  http.get(`${API}/health`, () =>
    HttpResponse.json({ status: 'ok', checks: { localstack: 'ok', mailpit: 'ok' } }),
  ),

  http.get(`${API}/overview`, () => HttpResponse.json(db.overview())),

  http.get(`${API}/scenarios`, () => HttpResponse.json(SCENARIOS)),

  http.post(`${API}/scenarios/:id/run`, ({ params }) => {
    const run = db.runScenario(String(params.id));
    if (run === 'busy') {
      return apiError(409, 'run_in_progress', 'A scenario is still running in the background.');
    }
    if (!run) return apiError(404, 'not_found', `Unknown scenario "${String(params.id)}".`);
    return HttpResponse.json(run, { status: 202 });
  }),

  http.get(`${API}/scenarios/runs/:runId`, ({ params }) => {
    const run = db.runStatus(String(params.runId));
    if (!run) return apiError(404, 'not_found', 'No run with this id.');
    return HttpResponse.json(run);
  }),

  http.get(`${API}/deliveries`, ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const category = url.searchParams.get('category');
    const kind = url.searchParams.get('kind');
    if (status && !(DELIVERY_STATUSES as readonly string[]).includes(status)) {
      return apiError(400, 'invalid_query', `Unknown status "${status}".`);
    }
    const filtered = db
      .deliveries()
      .filter(
        (d) =>
          (!status || d.status === status) &&
          (!category || d.category === category) &&
          (!kind || d.kind === kind),
      )
      .map(({ events: _events, mailId: _mailId, to: _to, ...summary }): DeliverySummary => summary);
    const page = paginate(filtered, url);
    if (!page) return apiError(400, 'invalid_cursor', 'The cursor is not valid.');
    return HttpResponse.json(page);
  }),

  http.get(`${API}/deliveries/:id`, ({ params }) => {
    const delivery = db.delivery(String(params.id));
    if (!delivery) return apiError(404, 'not_found', 'No delivery with this id.');
    const { to: _to, ...detail } = delivery;
    return HttpResponse.json(detail);
  }),

  http.get(`${API}/suppressions`, () =>
    HttpResponse.json({ items: db.suppressions(), nextCursor: null }),
  ),

  http.post(`${API}/feedback`, async ({ request }) => {
    const body = await jsonBody(request);
    if (!isRecord(body) || typeof body.email !== 'string' || typeof body.type !== 'string') {
      return apiError(400, 'invalid_request', 'type and email are required.');
    }
    if (!['bounce', 'complaint', 'delivery'].includes(body.type)) {
      return apiError(400, 'invalid_request', 'type must be bounce, complaint or delivery.');
    }
    if (!/^[^@\s]+@example\.test$/i.test(body.email)) {
      return apiError(400, 'invalid_request', 'Only @example.test addresses can be simulated.');
    }
    return HttpResponse.json(db.feedback(body as unknown as FeedbackRequest));
  }),

  http.get(`${API}/toggles`, () => HttpResponse.json(db.toggles())),

  http.put(`${API}/toggles/send-emails`, async ({ request }) => {
    const body = await jsonBody(request);
    const value = isRecord(body) ? body.value : undefined;
    if (value !== 'enabled' && value !== 'disabled') {
      return apiError(400, 'invalid_request', 'value must be enabled or disabled.');
    }
    db.setSendEmails(value satisfies ToggleValue);
    return HttpResponse.json({
      value,
      note: 'the processor picks it up within its cache TTL (5 min); the demo worker is restarted/refreshed',
    });
  }),

  http.post(`${API}/digest/run`, async ({ request }) => {
    const body = await jsonBody(request);
    const segment = isRecord(body) && typeof body.segment === 'number' ? body.segment : undefined;
    return HttpResponse.json(db.runDigest(segment === undefined ? { all: true } : { segment }));
  }),

  http.post(`${API}/reset`, () => {
    const before = db.overview();
    if (db.busy()) return apiError(409, 'run_in_progress', 'A scenario is still running.');
    db.reset({ seed: true, stepMs: db.stepMs() });
    const after = db.overview();
    return HttpResponse.json({
      cleared: {
        deliveries: Object.values(before.counts).reduce((a, b) => a + b, 0),
        deliveryLog: true,
        pendingDigest: 0,
        suppressions: Math.max(0, before.suppressions.total - after.suppressions.total),
        subscriptions: before.subscriptions.total,
        mail: true,
        queues: true,
      },
      seeded: {
        users: after.subscriptions.total,
        suppressed: after.suppressions.total,
        segments: 16,
      },
    });
  }),

  http.get(`${API}/mail`, ({ request }) => {
    const url = new URL(request.url);
    const items = db.mails().map((m): MailSummary => ({
      id: m.id,
      to: m.to,
      subject: m.subject,
      createdAt: m.createdAt,
      ...(m.deliveryId ? { deliveryId: m.deliveryId } : {}),
      ...(m.headers['X-Tag-Category']?.[0] ? { category: m.headers['X-Tag-Category'][0] } : {}),
      size: m.html.length + m.text.length,
    }));
    const page = paginate(items, url);
    if (!page) return apiError(400, 'invalid_cursor', 'The cursor is not valid.');
    return HttpResponse.json(page);
  }),

  http.get(`${API}/mail/:id`, ({ params }) => {
    const mail = db.mail(String(params.id));
    if (!mail) return apiError(404, 'not_found', 'No e-mail with this id.');
    return HttpResponse.json(mail);
  }),
];

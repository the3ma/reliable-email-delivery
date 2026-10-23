/**
 * In-memory stand-in for console-api (LocalStack + Mailpit behind it). Scenario runs apply their
 * effects either immediately (tests) or spread over a few seconds (dev:mock) so the "observed"
 * panel visibly catches up with "expected".
 */
import type {
  DeliveryDetail,
  DeliveryEvent,
  DeliveryStatus,
  DigestRequest,
  DigestResult,
  FeedbackRequest,
  FeedbackResult,
  MailMessage,
  Overview,
  Scenario,
  ScenarioRun,
  ScenarioRunStatus,
  Suppression,
  Toggles,
  ToggleValue,
} from '../api/types';
import { DELIVERY_STATUSES } from '../api/types';
import type { MockUser, RenderedMail } from './fixtures';
import { digest, fakeSha256, invoiceFailed, mask, reportReady, userAt, USERS } from './fixtures';

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'burst',
    title: 'Burst',
    description: '50 valid immediate requests for 20 users.',
    expected: '~50 e-mails, one per delivery id.',
  },
  {
    id: 'duplicate-storm',
    title: 'Duplicate storm',
    description:
      'The same 10 notifications published 12 times each, concurrently (the old system\'s "118 x" case).',
    expected: 'Exactly 10 e-mails; ~110 duplicates dropped (DuplicatesSuppressed).',
  },
  {
    id: 'invalid',
    title: 'Invalid requests',
    description:
      '5 malformed requests: bad JSON, unknown category, bad address, missing field, oversized.',
    expected: '0 e-mails, 0 retries, DLQs stay empty.',
  },
  {
    id: 'suppressed',
    title: 'Suppressed recipients',
    description: 'Notifications to pre-suppressed users.',
    expected: '0 e-mails; SKIPPED(suppressed).',
  },
  {
    id: 'digest',
    title: 'Daily digest',
    description: 'Queue digest items for 10 users, run all segments with ignoreWindow.',
    expected: 'One digest per user; a second run sends 0.',
  },
  {
    id: 'big-digest',
    title: 'Big digest',
    description: '400 large items for one user, then run the digest.',
    expected: 'The digest arrives in parts "part i/n", each its own delivery id.',
  },
  {
    id: 'kill-switch',
    title: 'Kill switch',
    description: 'Set send-emails = disabled, publish 10, set it back.',
    expected: '0 e-mails, 10 SKIPPED(disabled).',
  },
  {
    id: 'bounce',
    title: 'Bounce',
    description: 'Send to one user, simulate a permanent bounce, send again.',
    expected: 'First e-mail delivered, address suppressed, second SKIPPED(suppressed).',
  },
];

interface MockDelivery extends DeliveryDetail {
  to: string;
}

interface State {
  deliveries: MockDelivery[];
  mails: MailMessage[];
  suppressions: Suppression[];
  toggles: Toggles;
  pending: number;
  intakeDlq: number;
  emailDlq: number;
  digestRuns: Set<string>;
  runs: Map<string, ScenarioRunStatus>;
  seq: number;
  now: number;
}

export interface ResetOptions {
  /** Seed realistic history (dev:mock and most tests). */
  seed?: boolean;
  /** Spread scenario effects over time (ms between steps); null applies them synchronously. */
  stepMs?: number | null;
}

let state: State = emptyState();
let stepMs: number | null = null;
const timers = new Set<ReturnType<typeof setTimeout>>();

function emptyState(): State {
  return {
    deliveries: [],
    mails: [],
    suppressions: [],
    toggles: { sendEmails: 'enabled', recordDeliveries: 'enabled' },
    pending: 0,
    intakeDlq: 0,
    emailDlq: 0,
    digestRuns: new Set(),
    runs: new Map(),
    seq: 0,
    now: Date.now(),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const hashEmail = (email: string) => fakeSha256(`email:${email.toLowerCase()}`);

function nextTime(): number {
  state.seq += 1;
  return Math.max(Date.now(), state.now) + state.seq;
}

function isSuppressed(email: string): boolean {
  const hash = hashEmail(email);
  return state.suppressions.some((s) => s.emailHash === hash);
}

interface DeliverInput {
  user: MockUser;
  category: string;
  kind: 'immediate' | 'digest';
  entityId: string;
  mail: RenderedMail;
  at?: number;
  /** Force an outcome for seeded history; otherwise suppression and the kill switch decide. */
  outcome?: { status: DeliveryStatus; reason?: string; attempts?: number };
}

function addDelivery(input: DeliverInput): MockDelivery {
  const at = input.at ?? nextTime();
  const deliveryId = fakeSha256(`${input.user.userId}|${input.category}|${input.entityId}`);
  let status: DeliveryStatus = 'SENT';
  let reason: string | undefined;
  let attempts = 1;
  if (input.outcome) {
    status = input.outcome.status;
    reason = input.outcome.reason;
    attempts = input.outcome.attempts ?? 1;
  } else if (state.toggles.sendEmails === 'disabled') {
    status = 'SKIPPED';
    reason = 'disabled';
    attempts = 0;
  } else if (isSuppressed(input.user.email)) {
    status = 'SKIPPED';
    reason = 'suppressed';
    attempts = 0;
  }

  const events: DeliveryEvent[] = [];
  const event = (offset: number, name: string, details: Record<string, unknown>) => {
    events.push({ at: iso(at + offset), event: name, details });
  };
  const base = { category: input.category, kind: input.kind };
  switch (status) {
    case 'SENT':
      event(0, 'claimed', { ...base, leaseSeconds: 120 });
      event(180, 'sent', { ...base, sesMessageId: `mp-${deliveryId.slice(0, 12)}` });
      event(2_400, 'delivered', { ...base, source: 'mailpit' });
      break;
    case 'SKIPPED':
      event(0, 'skipped', { ...base, reason });
      break;
    case 'RELEASED':
      event(0, 'claimed', { ...base, leaseSeconds: 120 });
      event(900, 'released', { ...base, reason, attempts });
      break;
    case 'CLAIMED':
      event(0, 'claimed', { ...base, leaseSeconds: 120 });
      break;
    case 'FAILED_PERMANENT':
      event(0, 'claimed', { ...base, leaseSeconds: 120 });
      event(350, 'failed', { ...base, reason, permanent: true });
      break;
    case 'AMBIGUOUS':
      event(0, 'claimed', { ...base, leaseSeconds: 120 });
      event(121_000, 'ambiguous', {
        ...base,
        reason,
        note: 'lease expired before the send was confirmed; not resent automatically',
      });
      break;
  }

  const last = events[events.length - 1];
  const delivery: MockDelivery = {
    deliveryId,
    status,
    ...(reason ? { reason } : {}),
    category: input.category,
    kind: input.kind,
    userId: input.user.userId,
    to: input.user.email,
    toMasked: mask(input.user.email),
    attempts,
    updatedAt: last ? last.at : iso(at),
    events,
  };

  if (status === 'SENT') {
    const mailId = `mp${fakeSha256(`mail:${deliveryId}`).slice(0, 18)}`;
    delivery.mailId = mailId;
    state.mails.unshift({
      id: mailId,
      to: input.user.email,
      from: 'notifications@example.test',
      subject: input.mail.subject,
      createdAt: iso(at + 180),
      text: input.mail.text,
      html: input.mail.html,
      headers: {
        From: ['Notifications <notifications@example.test>'],
        To: [input.user.email],
        Subject: [input.mail.subject],
        Date: [new Date(at + 180).toUTCString()],
        'Message-ID': [`<${deliveryId.slice(0, 24)}@example.test>`],
        'Content-Type': ['multipart/alternative; boundary="b1"'],
        // Mailpit canonicalises header names like this.
        'X-Tag-Deliveryid': [deliveryId],
        'X-Tag-Category': [input.category],
        'X-Tag-Kind': [input.kind],
      },
      deliveryId,
    });
  }
  state.deliveries = [delivery, ...state.deliveries.filter((d) => d.deliveryId !== deliveryId)];
  return delivery;
}

function addSuppression(email: string, reason: string, source: string, at = nextTime()): boolean {
  const hash = hashEmail(email);
  const existing = state.suppressions.find((s) => s.emailHash === hash);
  if (existing) {
    existing.lastEventAt = iso(at);
    return true;
  }
  state.suppressions.unshift({
    emailHash: hash,
    reason,
    source,
    createdAt: iso(at),
    lastEventAt: iso(at),
  });
  return true;
}

function seed(): void {
  const t0 = state.now - 6 * 3_600_000;
  const step = (i: number) => t0 + i * 7 * 60_000;

  addSuppression(userAt(17).email, 'bounce_permanent', 'seed', step(0));
  addSuppression(userAt(18).email, 'complaint', 'seed', step(1));
  addSuppression(userAt(19).email, 'manual', 'seed', step(2));

  for (let i = 0; i < 18; i++) {
    const user = userAt(i);
    const invoice = i % 4 === 1;
    addDelivery({
      user,
      category: invoice ? 'invoice_failed' : 'report_ready',
      kind: 'immediate',
      entityId: `seed-${i}`,
      mail: invoice ? invoiceFailed() : reportReady(`Q3 usage #${i + 1}`, { tracking: i === 0 }),
      at: step(3 + i),
    });
  }

  const seededOutcome = (
    i: number,
    status: DeliveryStatus,
    reason: string,
    attempts: number,
    category = 'report_ready',
  ) =>
    addDelivery({
      user: userAt(i),
      category,
      kind: 'immediate',
      entityId: `seed-${status}-${i}`,
      mail: reportReady('Weekly summary'),
      at: step(22 + i),
      outcome: { status, reason, attempts },
    });
  seededOutcome(17, 'SKIPPED', 'suppressed', 0);
  seededOutcome(18, 'SKIPPED', 'suppressed', 0, 'invoice_failed');
  seededOutcome(3, 'SKIPPED', 'disabled', 0);
  seededOutcome(9, 'SKIPPED', 'invalid:html_too_large', 0);
  seededOutcome(4, 'RELEASED', 'Throttling', 1);
  seededOutcome(5, 'CLAIMED', '', 0);
  seededOutcome(6, 'FAILED_PERMANENT', 'MessageRejected', 1, 'invoice_failed');
  seededOutcome(7, 'AMBIGUOUS', 'lease_expired', 1);

  // A digest too big for one message: three parts, each its own delivery id.
  const digestUser = userAt(8);
  for (let part = 1; part <= 3; part++) {
    addDelivery({
      user: digestUser,
      category: 'digest',
      kind: 'digest',
      entityId: `daily#p${part}`,
      mail: digest(part === 3 ? 12 : 40, { index: part, total: 3 }),
      at: step(32 + part),
    });
  }
  for (let i = 9; i < 13; i++) {
    addDelivery({
      user: userAt(i),
      category: 'digest',
      kind: 'digest',
      entityId: 'daily',
      mail: digest(3 + (i % 3)),
      at: step(28 + i),
    });
  }
  // A record written before the processor stored recipient metadata: list fields are null.
  state.deliveries.push({
    deliveryId: fakeSha256('legacy-record'),
    status: 'SKIPPED',
    reason: 'disabled',
    category: null,
    kind: null,
    userId: null,
    toMasked: null,
    to: '',
    attempts: 0,
    updatedAt: iso(t0 - 86_400_000),
    events: [
      { at: iso(t0 - 86_400_000), event: 'skipped', details: { reason: 'disabled', legacy: true } },
    ],
  });
  state.seq = 0;
}

export const db = {
  reset(options: ResetOptions = {}): void {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    stepMs = options.stepMs ?? null;
    state = emptyState();
    if (options.seed ?? true) seed();
  },

  overview(): Overview {
    const counts = Object.fromEntries(DELIVERY_STATUSES.map((s) => [s, 0])) as Record<
      DeliveryStatus,
      number
    >;
    const skippedByReason: Record<string, number> = {};
    for (const d of state.deliveries) {
      counts[d.status] += 1;
      if (d.status === 'SKIPPED') {
        const reason = d.reason ?? 'unknown';
        skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
      }
    }
    return {
      counts,
      skippedByReason,
      queues: {
        intake: { visible: Math.ceil(state.pending / 2), inFlight: state.pending > 0 ? 1 : 0 },
        intakeDlq: { visible: state.intakeDlq, inFlight: 0 },
        email: { visible: state.pending, inFlight: Math.min(state.pending, 10) },
        emailDlq: { visible: state.emailDlq, inFlight: 0 },
      },
      toggles: { ...state.toggles },
      mail: { total: state.mails.length },
      suppressions: { total: state.suppressions.length },
      subscriptions: { total: USERS.length },
    };
  },

  stepMs(): number | null {
    return stepMs;
  },

  busy(): boolean {
    return [...state.runs.values()].some((r) => r.status === 'running');
  },

  toggles(): Toggles {
    return { ...state.toggles };
  },

  setSendEmails(value: ToggleValue): void {
    state.toggles.sendEmails = value;
  },

  deliveries(): readonly MockDelivery[] {
    return state.deliveries;
  },

  delivery(id: string): MockDelivery | undefined {
    return state.deliveries.find((d) => d.deliveryId === id);
  },

  mails(): readonly MailMessage[] {
    return state.mails;
  },

  mail(id: string): MailMessage | undefined {
    return state.mails.find((m) => m.id === id);
  },

  suppressions(): readonly Suppression[] {
    return state.suppressions;
  },

  feedback(req: FeedbackRequest): FeedbackResult {
    const permanent = (req.type === 'bounce' && req.transient !== true) || req.type === 'complaint';
    const user = USERS.find((u) => u.email === req.email.toLowerCase());
    const target = state.deliveries.find((d) => d.to === req.email.toLowerCase());
    if (target) {
      target.events.push({
        at: iso(nextTime()),
        event:
          req.type === 'complaint' ? 'complained' : req.type === 'bounce' ? 'bounced' : 'delivered',
        details: { transient: req.transient ?? false, source: 'console' },
      });
    }
    if (!permanent) return { ok: true, suppressed: false };
    addSuppression(
      user?.email ?? req.email,
      req.type === 'complaint' ? 'complaint' : 'bounce_permanent',
      req.type === 'complaint' ? 'ses-complaint' : 'ses-bounce',
    );
    return { ok: true, suppressed: true };
  },

  runDigest(req: DigestRequest): DigestResult {
    const key = `manual-${String(req.segment ?? 'all')}`;
    if (state.digestRuns.has(key)) return digestResult(0);
    state.digestRuns.add(key);
    schedule(
      [0, 1, 2, 3].map((i) => () => {
        addDelivery({
          user: userAt(13 + i),
          category: 'digest',
          kind: 'digest',
          entityId: `daily-${key}`,
          mail: digest(2 + i),
        });
      }),
    );
    return digestResult(4);
  },

  /** `busy` mirrors console-api's 409 run_in_progress while a run is still working. */
  runScenario(id: string): ScenarioRun | 'busy' | undefined {
    if (!SCENARIOS.some((s) => s.id === id)) return undefined;
    if (db.busy()) return 'busy';
    const plan = scenarioPlan(id);
    if (!plan) return undefined;
    const runId = `run-${fakeSha256(`${id}:${String(nextTime())}`).slice(0, 10)}`;
    const run: ScenarioRunStatus = {
      runId,
      scenario: id,
      startedAt: iso(Date.now()),
      status: 'running',
      published: plan.published,
      notes: [...plan.notes],
    };
    state.runs.set(runId, run);
    schedule(plan.steps, () => {
      run.status = 'done';
      run.finishedAt = iso(Date.now());
      run.notes = [...run.notes, 'Finished.'];
    });
    const { scenario: _scenario, status: _status, ...started } = run;
    return { ...started, notes: [...plan.notes] };
  },

  runStatus(runId: string): ScenarioRunStatus | undefined {
    const run = state.runs.get(runId);
    return run ? { ...run, notes: [...run.notes] } : undefined;
  },
};

/** Runs `steps` now (tests) or one every `stepMs` while counting them as queued work. */
function schedule(steps: (() => void)[], onDone?: () => void): void {
  if (stepMs === null || steps.length === 0) {
    for (const step of steps) step();
    onDone?.();
    return;
  }
  let left = steps.length;
  state.pending += steps.length;
  steps.forEach((step, i) => {
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        state.pending = Math.max(0, state.pending - 1);
        step();
        left -= 1;
        if (left === 0) onDone?.();
      },
      (stepMs ?? 0) * (1 + Math.floor(i / 5)),
    );
    timers.add(timer);
  });
}

function digestResult(queued: number): DigestResult {
  return {
    users: 4,
    due: 4,
    queued,
    alreadyDelivered: 4 - queued,
    nothingPending: 0,
    parts: queued,
    remaining: 0,
    failed: 0,
    failures: [],
  };
}

interface Plan {
  published: number;
  notes: string[];
  steps: (() => void)[];
}

let runCounter = 0;

function immediate(user: MockUser, entityId: string, invoice = false): () => void {
  return () => {
    addDelivery({
      user,
      category: invoice ? 'invoice_failed' : 'report_ready',
      kind: 'immediate',
      entityId,
      mail: invoice ? invoiceFailed() : reportReady(`Report ${entityId}`),
    });
  };
}

function scenarioPlan(id: string): Plan | undefined {
  runCounter += 1;
  const run = runCounter;
  switch (id) {
    case 'burst':
      return {
        published: 50,
        notes: ['50 notification.requested events published for 20 users.'],
        steps: Array.from({ length: 50 }, (_, i) =>
          immediate(userAt(i % 17), `burst-${run}-${i}`, i % 5 === 0),
        ),
      };
    case 'duplicate-storm':
      return {
        published: 120,
        notes: [
          '10 notifications x 12 copies published concurrently.',
          'Expect DuplicatesSuppressed ~110 in the processor metrics.',
        ],
        steps: Array.from({ length: 10 }, (_, i) => immediate(userAt(i), `storm-${run}-${i}`)),
      };
    case 'invalid':
      return {
        published: 5,
        notes: ['Rejected by the request schema before any claim; nothing is retried.'],
        steps: [],
      };
    case 'suppressed':
      return {
        published: 3,
        notes: ['Recipients are on the suppression list (seeded).'],
        steps: [17, 18, 19].map((i) => () => {
          addDelivery({
            user: userAt(i),
            category: 'report_ready',
            kind: 'immediate',
            entityId: `supp-${run}-${i}`,
            mail: reportReady('Blocked'),
            outcome: { status: 'SKIPPED', reason: 'suppressed', attempts: 0 },
          });
        }),
      };
    case 'digest': {
      const already = state.digestRuns.has('scenario');
      state.digestRuns.add('scenario');
      return {
        published: already ? 0 : 30,
        notes: already
          ? ["All 10 users already received today's digest: 0 queued, 10 alreadyDelivered."]
          : ['30 digest items queued for 10 users; all 16 segments run with ignoreWindow.'],
        steps: already
          ? []
          : Array.from({ length: 10 }, (_, i) => () => {
              addDelivery({
                user: userAt(i),
                category: 'digest',
                kind: 'digest',
                entityId: 'daily-scenario',
                mail: digest(3),
              });
            }),
      };
    }
    case 'big-digest':
      return {
        published: 400,
        notes: ['400 large items for one user; the notifier splits by the 200 KiB body budget.'],
        steps: [1, 2, 3, 4].map((part) => () => {
          addDelivery({
            user: userAt(2),
            category: 'digest',
            kind: 'digest',
            entityId: `big-${run}#p${part}`,
            mail: digest(100, { index: part, total: 4 }),
          });
        }),
      };
    case 'kill-switch':
      return {
        published: 10,
        notes: ['send-emails set to disabled, 10 published, then set back to enabled.'],
        steps: Array.from({ length: 10 }, (_, i) => () => {
          addDelivery({
            user: userAt(i),
            category: 'report_ready',
            kind: 'immediate',
            entityId: `kill-${run}-${i}`,
            mail: reportReady('Not sent'),
            outcome: { status: 'SKIPPED', reason: 'disabled', attempts: 0 },
          });
        }),
      };
    case 'bounce': {
      const user = userAt(14);
      return {
        published: 2,
        notes: [`One e-mail to ${mask(user.email)}, a permanent bounce, then a second e-mail.`],
        steps: [
          immediate(user, `bounce-${run}-1`),
          () => {
            addSuppression(user.email, 'bounce_permanent', 'ses-bounce');
          },
          () => {
            addDelivery({
              user,
              category: 'report_ready',
              kind: 'immediate',
              entityId: `bounce-${run}-2`,
              mail: reportReady('Second'),
            });
          },
        ],
      };
    }
    default:
      return undefined;
  }
}

import { randomUUID } from 'node:crypto';
import {
  DeliveryStatus,
  hasImmediateTemplate,
  immediateDeliveryId,
  pendingDigestSortKey,
  sha256Hex,
  stableSegment,
} from '@mail/core';
import type { Category, Subscription } from '@mail/core';
import { TIMEZONES, seedSubscription } from '@mail/functions';
import type { ConsoleDeps } from './ports.js';

export interface ScenarioInfo {
  id: string;
  title: string;
  description: string;
  expected: string;
}

export const SCENARIOS: readonly ScenarioInfo[] = [
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
      '5 malformed messages: bad JSON, unknown category, bad address, missing field, oversized.',
    expected: '0 e-mails, 0 retries, DLQs stay empty.',
  },
  {
    id: 'suppressed',
    title: 'Suppressed recipients',
    description: 'Notifications to the pre-suppressed seed users.',
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
    title: 'Oversized digest',
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
    title: 'Permanent bounce',
    description: 'Send to one user, simulate a permanent bounce, send again.',
    expected: 'First e-mail delivered, address suppressed, second SKIPPED(suppressed).',
  },
];

export interface ScenarioRun {
  runId: string;
  scenario: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  published: number;
  notes: string[];
}

/** What a scenario needs from the app besides the ports: the in-process digest and feedback. */
export interface ScenarioTools {
  runDigest(options: {
    segments: number[];
    ignoreWindow: boolean;
  }): Promise<{ messages: number; queued: number }>;
  feedback(options: {
    type: 'bounce';
    email: string;
    deliveryId?: string;
  }): Promise<{ suppressed: number }>;
}

interface Started {
  published: number;
  notes: string[];
  /** Work that continues after the HTTP response (waits on the workers). */
  background?: () => Promise<string[]>;
}

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ScenarioRunner {
  private readonly runs = new Map<string, ScenarioRun>();
  private busy: string | undefined;
  private readonly clock: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly deps: ConsoleDeps,
    private readonly tools: ScenarioTools,
  ) {
    this.clock = deps.clock ?? (() => new Date());
    this.sleep = deps.sleep ?? sleepFor;
  }

  get(runId: string): ScenarioRun | undefined {
    return this.runs.get(runId);
  }

  /** A background scenario (kill switch, bounce) changes shared state, so only one runs at a time. */
  get busyWith(): string | undefined {
    return this.busy;
  }

  /** Background work, exposed so tests can await it. */
  pending: Promise<void> = Promise.resolve();

  async run(id: string): Promise<ScenarioRun> {
    const runId = randomUUID();
    const short = runId.slice(0, 8);
    const started = await this.start(id, short);
    const run: ScenarioRun = {
      runId,
      scenario: id,
      startedAt: this.clock().toISOString(),
      status: started.background ? 'running' : 'done',
      published: started.published,
      notes: started.notes,
    };
    if (!started.background) run.finishedAt = run.startedAt;
    this.remember(run);

    const background = started.background;
    if (background) {
      this.busy = runId;
      this.pending = background()
        .then((notes) => {
          run.notes.push(...notes);
          run.status = 'done';
        })
        .catch((error: unknown) => {
          run.status = 'failed';
          run.notes.push(`failed: ${error instanceof Error ? error.message : String(error)}`);
          this.deps.log.error('scenario failed', error, { scenario: id, runId });
        })
        .finally(() => {
          run.finishedAt = this.clock().toISOString();
          this.busy = undefined;
        });
    }
    return run;
  }

  private remember(run: ScenarioRun): void {
    this.runs.set(run.runId, run);
    while (this.runs.size > 50) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) break;
      this.runs.delete(oldest);
    }
  }

  // --- users ---------------------------------------------------------------------------------

  private seedUser(index: number): Subscription {
    return seedSubscription(index, this.deps.config.segments);
  }

  private isSuppressedSeed(index: number): boolean {
    const every = this.deps.config.seed.suppressEvery;
    return every > 0 && index % every === 0;
  }

  /** Seed users that get report_ready immediately and are not pre-suppressed. */
  private async immediateUsers(count: number): Promise<Subscription[]> {
    const users: Subscription[] = [];
    for (let i = 1; i <= this.deps.config.seed.users && users.length < count; i += 1) {
      const user = this.seedUser(i);
      if (!this.isSuppressedSeed(i) && user.immediate.includes('report_ready')) users.push(user);
    }
    // Scenarios must not depend on someone having run `seed` first; this is the seed data anyway.
    for (const user of users) await this.deps.subscriptions.put(user);
    return users;
  }

  /** A user that exists only for this run, so a scenario can be re-run without a reset. */
  private async freshUser(
    prefix: string,
    short: string,
    n: number,
    preferences: Pick<Subscription, 'immediate' | 'digest'>,
  ): Promise<Subscription> {
    const userId = `u-${prefix}-${short}-${String(n)}`;
    const user: Subscription = {
      userId,
      email: `${prefix}-${short}-${String(n)}@example.test`,
      timezone: TIMEZONES[n % TIMEZONES.length] ?? 'UTC',
      locale: 'en',
      ...preferences,
      segment: stableSegment(userId, this.deps.config.segments),
    };
    await this.deps.subscriptions.put(user);
    return user;
  }

  private request(
    userId: string,
    category: Category,
    entityId: string,
    data: Record<string, string>,
  ) {
    return {
      requestId: randomUUID(),
      userId,
      category,
      entityId,
      occurredAt: this.clock().toISOString(),
      data,
    };
  }

  // --- scenarios -------------------------------------------------------------------------------

  private async start(id: string, short: string): Promise<Started> {
    switch (id) {
      case 'burst':
        return this.burst(short);
      case 'duplicate-storm':
        return this.duplicateStorm(short);
      case 'invalid':
        return this.invalid(short);
      case 'suppressed':
        return this.suppressed(short);
      case 'digest':
        return this.digest(short);
      case 'big-digest':
        return this.bigDigest(short);
      case 'kill-switch':
        return this.killSwitch(short);
      case 'bounce':
        return this.bounce(short);
      default:
        throw new Error(`unknown scenario ${id}`);
    }
  }

  private async burst(short: string): Promise<Started> {
    const users = await this.immediateUsers(20);
    const requests = Array.from({ length: 50 }, (_, i) => {
      const user = users[i % users.length];
      if (!user) throw new Error('no eligible seed users');
      return this.request(user.userId, 'report_ready', `burst-${short}-${String(i)}`, {
        reportName: `Burst report ${String(i + 1)}`,
      });
    });
    const { published, failed } = await this.deps.publisher.putEvents(requests);
    return {
      published,
      notes: [
        `${String(published)} requests for ${String(users.length)} users published to EventBridge`,
        ...(failed > 0 ? [`${String(failed)} failed to publish`] : []),
      ],
    };
  }

  private async duplicateStorm(short: string): Promise<Started> {
    const users = await this.immediateUsers(10);
    const originals = users.map((user, i) =>
      this.request(user.userId, 'report_ready', `storm-${short}-${String(i)}`, {
        reportName: `Storm report ${String(i + 1)}`,
      }),
    );
    // Half the copies are redeliveries (same requestId), half a producer re-emitting the same
    // event (new requestId): both map to the same deliveryId.
    const copies = originals.flatMap((original) =>
      Array.from({ length: 12 }, (_, copy) =>
        copy % 2 === 0 ? original : { ...original, requestId: randomUUID() },
      ),
    );
    for (let i = copies.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = copies[i];
      const b = copies[j];
      if (a && b) {
        copies[i] = b;
        copies[j] = a;
      }
    }
    const { published } = await this.deps.publisher.putEvents(copies);
    return {
      published,
      notes: [
        `10 notifications x 12 copies = ${String(published)} requests, published concurrently`,
        'expect exactly 10 e-mails; the rest end as DuplicatesSuppressed (processor) or upstream skips',
      ],
    };
  }

  private async invalid(short: string): Promise<Started> {
    const [user] = await this.immediateUsers(1);
    if (!user) throw new Error('no eligible seed users');
    const valid = this.request(user.userId, 'report_ready', `invalid-${short}`, {
      reportName: 'x',
    });
    const missingField: Partial<typeof valid> = { ...valid, requestId: randomUUID() };
    delete missingField.entityId;
    const intake = [
      '{"requestId": "broken json',
      JSON.stringify({ ...valid, requestId: randomUUID(), category: 'newsletter' }),
      JSON.stringify(missingField),
    ];
    const emailMessage = (deliveryId: string, to: string, html: string) =>
      JSON.stringify({
        deliveryId,
        userId: user.userId,
        to,
        templateId: 'report_ready',
        subject: 'Invalid scenario',
        text: 'Invalid scenario',
        html,
        category: 'report_ready',
        kind: 'immediate',
        requestIds: [randomUUID()],
        redact: false,
        createdAt: this.clock().toISOString(),
      });
    const email = [
      emailMessage(sha256Hex(`invalid-address-${short}`), 'not-an-address', '<p>x</p>'),
      emailMessage(
        sha256Hex(`invalid-oversized-${short}`),
        user.email,
        `<p>${'x'.repeat(201 * 1024)}</p>`,
      ),
    ];
    const a = await this.deps.publisher.sendRaw('intake', intake);
    const b = await this.deps.publisher.sendRaw('email', email);
    return {
      published: a.published + b.published,
      notes: [
        'intake: bad JSON, unknown category, missing entityId',
        'email queue: invalid recipient address, html over 200 KiB (SKIPPED invalid:html_too_large)',
        'all are permanent: no e-mail, no retry, DLQs stay empty',
      ],
    };
  }

  private async suppressed(short: string): Promise<Started> {
    const users: Subscription[] = [];
    for (let i = 1; i <= this.deps.config.seed.users; i += 1) {
      const user = this.seedUser(i);
      if (this.isSuppressedSeed(i) && user.immediate.includes('report_ready')) users.push(user);
    }
    if (users.length === 0) {
      return { published: 0, notes: ['no pre-suppressed seed users (SEED_SUPPRESS_EVERY=0)'] };
    }
    for (const user of users) await this.deps.subscriptions.put(user);
    const requests = users.map((user, i) =>
      this.request(user.userId, 'report_ready', `suppressed-${short}-${String(i)}`, {
        reportName: 'Suppressed report',
      }),
    );
    const { published } = await this.deps.publisher.putEvents(requests);
    return {
      published,
      notes: [
        `${String(published)} requests to pre-suppressed users (${users.map((u) => u.userId).join(', ')})`,
        'requires the seeded suppressions (POST /reset re-seeds them)',
      ],
    };
  }

  private async addPending(
    user: Subscription,
    category: Category,
    entityId: string,
    data: Record<string, string>,
  ) {
    const requestId = randomUUID();
    const occurredAt = this.clock().toISOString();
    await this.deps.pendingDigest.add({
      userId: user.userId,
      sk: pendingDigestSortKey(occurredAt, requestId),
      requestId,
      category,
      entityId,
      occurredAt,
      data,
      segment: user.segment,
      expiresAt: Math.floor(this.clock().getTime() / 1000) + 14 * 86_400,
    });
  }

  private async digest(short: string): Promise<Started> {
    const users: Subscription[] = [];
    for (let n = 1; n <= 10; n += 1) {
      const user = await this.freshUser('dg', short, n, {
        immediate: [],
        digest: ['comment_added', 'usage_alert', 'report_ready'],
      });
      users.push(user);
      await this.addPending(user, 'comment_added', `doc-${short}-${String(n)}`, {
        subject: `Document ${String(n)}`,
      });
      await this.addPending(user, 'usage_alert', `use-${short}-${String(n)}`, {
        metric: 'API calls at 90% of plan',
      });
      await this.addPending(user, 'report_ready', `rep-${short}-${String(n)}`, {
        reportName: `Weekly report ${String(n)}`,
      });
    }
    const all = Array.from({ length: this.deps.config.segments }, (_, i) => i);
    const result = await this.tools.runDigest({ segments: all, ignoreWindow: true });
    return {
      published: result.messages,
      notes: [
        '10 users with 3 pending items each; all segments run with ignoreWindow',
        `${String(result.queued)} digests queued (${String(result.messages)} e-mails)`,
        'run POST /digest/run { "all": true, "ignoreWindow": true } again: 0 are sent (one digest per user per local day)',
      ],
    };
  }

  private async bigDigest(short: string): Promise<Started> {
    const user = await this.freshUser('big', short, 1, {
      immediate: [],
      digest: ['comment_added'],
    });
    for (let i = 0; i < 400; i += 1) {
      await this.addPending(user, 'comment_added', `big-${short}-${String(i)}`, {
        subject: `Long thread ${String(i)} ${'lorem ipsum '.repeat(160)}`.slice(0, 2000),
      });
    }
    const result = await this.tools.runDigest({ segments: [user.segment], ignoreWindow: true });
    return {
      published: result.messages,
      notes: [
        `400 items of ~2 KB for ${user.userId}`,
        `queued as ${String(result.messages)} parts, each with its own delivery id (<local date>#p<n>)`,
      ],
    };
  }

  private async waitFor(predicate: () => Promise<boolean>): Promise<boolean> {
    const deadline = this.clock().getTime() + this.deps.config.scenarioWaitMs;
    for (;;) {
      if (await predicate()) return true;
      if (this.clock().getTime() >= deadline) return false;
      await this.sleep(1_000);
    }
  }

  private async killSwitch(short: string): Promise<Started> {
    const users = await this.immediateUsers(10);
    const requests = users.map((user, i) =>
      this.request(user.userId, 'report_ready', `kill-${short}-${String(i)}`, {
        reportName: `Kill switch report ${String(i + 1)}`,
      }),
    );
    const ids = requests.map((r) => immediateDeliveryId(r.userId, r.category, r.entityId));
    const ttl = this.deps.config.workerToggleTtlSeconds;
    return {
      published: requests.length,
      notes: [
        `send-emails -> disabled; waiting ${String(ttl + 2)} s for the workers' toggle cache (TOGGLE_CACHE_TTL_SECONDS=${String(ttl)})`,
      ],
      background: async () => {
        const notes: string[] = [];
        await this.deps.toggles.setSendEmails('disabled');
        try {
          await this.sleep((ttl + 2) * 1000);
          await this.deps.publisher.putEvents(requests);
          notes.push(`published ${String(requests.length)} requests while disabled`);
          const settled = await this.waitFor(async () => {
            for (const id of ids) if (!(await this.deps.deliveries.get(id))) return false;
            return true;
          });
          notes.push(settled ? 'all 10 processed' : 'timed out waiting for the processor');
        } finally {
          await this.deps.toggles.setSendEmails('enabled');
          notes.push('send-emails -> enabled');
        }
        return notes;
      },
    };
  }

  private async bounce(short: string): Promise<Started> {
    const user = await this.freshUser('bounce', short, 1, {
      immediate: ['report_ready'],
      digest: [],
    });
    const first = this.request(user.userId, 'report_ready', `bounce-${short}-1`, {
      reportName: 'Before the bounce',
    });
    const second = this.request(user.userId, 'report_ready', `bounce-${short}-2`, {
      reportName: 'After the bounce',
    });
    const firstId = immediateDeliveryId(first.userId, first.category, first.entityId);
    if (!hasImmediateTemplate(first.category)) throw new Error('report_ready must be immediate');
    await this.deps.publisher.putEvents([first]);
    return {
      published: 1,
      notes: [
        `sent to ${user.userId}; waiting for it to be delivered before simulating the bounce`,
      ],
      background: async () => {
        const notes: string[] = [];
        const sent = await this.waitFor(async () => {
          return (await this.deps.deliveries.get(firstId))?.status === DeliveryStatus.SENT;
        });
        if (!sent) return ['timed out waiting for the first e-mail; bounce not simulated'];
        notes.push('first e-mail SENT');
        const { suppressed } = await this.tools.feedback({
          type: 'bounce',
          email: user.email,
          deliveryId: firstId,
        });
        notes.push(`permanent bounce simulated; ${String(suppressed)} address suppressed`);
        await this.deps.publisher.putEvents([second]);
        notes.push('second request published: expect SKIPPED(suppressed)');
        return notes;
      },
    };
  }
}

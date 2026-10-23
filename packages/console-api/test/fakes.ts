import { Logger } from '@aws-lambda-powertools/logger';
import { ToggleCache } from '@mail/core';
import type { MailTransport, OutgoingEmail, SendResult, SuppressionRecord } from '@mail/core';
import {
  InMemoryDeliveriesStore,
  InMemoryDeliveryLog,
  InMemoryPendingDigest,
  InMemorySubscriptions,
  InMemorySuppressions,
} from '@mail/core/testing';
import {
  MemoryEmailQueue,
  SafeLog,
  createNotifierImmediate,
  createProcessor,
} from '@mail/functions';
import type { Publisher, QueueName, Telemetry } from '@mail/functions';
import type { SQSRecord } from 'aws-lambda';
import { vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type {
  ConsoleDeps,
  MailClient,
  MailMessage,
  MailSummary,
  QueueAdmin,
  QueueDepth,
  QueueKey,
  ToggleValue,
  TogglesAdmin,
} from '../src/ports.js';

export const NOW = new Date('2026-10-23T07:30:00Z');

export class CountingTelemetry implements Telemetry {
  readonly counts = new Map<string, number>();
  count(name: string, value = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + value);
  }
  flush(): void {
    /* nothing buffered */
  }
  get(name: string): number {
    return this.counts.get(name) ?? 0;
  }
}

export class FakeToggles implements TogglesAdmin {
  values: { sendEmails: ToggleValue; recordDeliveries: ToggleValue } = {
    sendEmails: 'enabled',
    recordDeliveries: 'enabled',
  };
  readonly history: ToggleValue[] = [];

  get() {
    return Promise.resolve({ ...this.values });
  }

  setSendEmails(value: ToggleValue): Promise<void> {
    this.values.sendEmails = value;
    this.history.push(value);
    return Promise.resolve();
  }
}

export class FakeQueues implements QueueAdmin {
  depthsValue: Record<QueueKey, QueueDepth> = {
    intake: { visible: 1, inFlight: 0 },
    intakeDlq: { visible: 0, inFlight: 0 },
    email: { visible: 2, inFlight: 1 },
    emailDlq: { visible: 0, inFlight: 0 },
  };
  purged = 0;

  depths() {
    return Promise.resolve(this.depthsValue);
  }

  purgeAll(): Promise<void> {
    this.purged += 1;
    return Promise.resolve();
  }
}

interface StoredMail {
  message: MailMessage;
  headers: Record<string, string[]>;
}

export class FakeMailbox implements MailClient {
  readonly mails: StoredMail[] = [];
  up = true;

  add(message: MailMessage, headers: Record<string, string[]>): void {
    this.mails.unshift({ message, headers });
  }

  list(start: number, limit: number): Promise<{ total: number; messages: MailSummary[] }> {
    return Promise.resolve({
      total: this.mails.length,
      messages: this.mails.slice(start, start + limit).map(({ message }) => ({
        id: message.id,
        messageId: message.messageId,
        to: message.to,
        subject: message.subject,
        createdAt: message.createdAt,
        size: message.size,
      })),
    });
  }

  get(id: string): Promise<MailMessage | undefined> {
    return Promise.resolve(this.mails.find((m) => m.message.id === id)?.message);
  }

  headers(id: string): Promise<Record<string, string[]> | undefined> {
    return Promise.resolve(this.mails.find((m) => m.message.id === id)?.headers);
  }

  findByMessageId(messageId: string): Promise<string | undefined> {
    return Promise.resolve(this.mails.find((m) => m.message.messageId === messageId)?.message.id);
  }

  deleteAll(): Promise<void> {
    this.mails.length = 0;
    return Promise.resolve();
  }

  ping(): Promise<boolean> {
    return Promise.resolve(this.up);
  }
}

/** Behaves like SMTP into Mailpit: Message-ID in angle brackets, tags as canonicalised headers. */
export class MailboxTransport implements MailTransport {
  readonly name = 'smtp' as const;
  readonly sent: OutgoingEmail[] = [];
  private counter = 0;

  constructor(private readonly mailbox: FakeMailbox) {}

  send(email: OutgoingEmail): Promise<SendResult> {
    this.counter += 1;
    const messageId = `msg-${String(this.counter)}@local.test`;
    this.sent.push(email);
    this.mailbox.add(
      {
        id: `mp-${String(this.counter)}`,
        messageId,
        to: [email.to],
        from: email.from,
        subject: email.subject,
        createdAt: NOW.toISOString(),
        size: email.html.length + email.text.length,
        text: email.text,
        html: email.html,
      },
      {
        Subject: [email.subject],
        'X-Tag-Deliveryid': [email.tags.deliveryId ?? ''],
        'X-Tag-Category': [email.tags.category ?? ''],
      },
    );
    return Promise.resolve({ messageId: `<${messageId}>` });
  }
}

let record = 0;
function sqsRecord(body: string): SQSRecord {
  record += 1;
  return {
    messageId: `r-${String(record)}`,
    receiptHandle: `rh-${String(record)}`,
    body,
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '0',
      SenderId: 'test',
      ApproximateFirstReceiveTimestamp: '0',
    },
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:test',
    awsRegion: 'us-east-1',
  };
}

/**
 * The local stack in memory: the real notifier-immediate and processor logic over the same fakes
 * the console reads, with several concurrent "workers" per queue like the Lambda poller.
 */
export class Pipeline implements Publisher {
  readonly intake: string[] = [];
  readonly emailQueue = new MemoryEmailQueue();
  readonly transport: MailboxTransport;
  readonly telemetry = new CountingTelemetry();
  readonly published: unknown[] = [];
  /** Drain after every publish, as the workers would. */
  auto = true;
  private invocation = 0;
  private readonly notifier: ReturnType<typeof createNotifierImmediate>;
  private readonly processor: ReturnType<typeof createProcessor>;

  constructor(
    private readonly world: World,
    private readonly workers = 3,
  ) {
    this.transport = new MailboxTransport(world.mail);
    this.notifier = createNotifierImmediate({
      subscriptions: world.subscriptions,
      pendingDigest: world.pendingDigest,
      deliveries: world.deliveries,
      emailQueue: this.emailQueue,
      log: world.log,
      telemetry: this.telemetry,
      appBaseUrl: 'http://localhost:8080',
      clock: () => NOW,
    });
    const toggles = world.toggles;
    this.processor = createProcessor({
      deliveries: world.deliveries,
      deliveryLog: world.deliveryLog,
      suppressions: world.suppressions,
      transport: this.transport,
      // TOGGLE_CACHE_TTL_SECONDS=0: every batch sees the current SSM value.
      toggles: new ToggleCache(
        {
          fetch: async () => {
            const v = await toggles.get();
            return { 'send-emails': v.sendEmails, 'record-deliveries': v.recordDeliveries };
          },
        },
        { ttlMs: 0 },
      ),
      log: world.log,
      telemetry: this.telemetry,
      fromAddress: 'notifications@example.test',
      hardDisabled: 'false',
      clock: () => NOW,
    });
  }

  async putEvents(details: readonly unknown[]) {
    this.published.push(...details);
    this.intake.push(...details.map((d) => JSON.stringify(d)));
    if (this.auto) await this.drain();
    return { published: details.length, failed: 0 };
  }

  async sendRaw(queue: QueueName, bodies: readonly string[]) {
    if (queue === 'intake') this.intake.push(...bodies);
    else {
      // Raw email-queue bodies may be invalid JSON on purpose; keep them as strings.
      this.rawEmail.push(...bodies);
    }
    if (this.auto) await this.drain();
    return { published: bodies.length, failed: 0 };
  }

  readonly rawEmail: string[] = [];

  /** Runs both queues to empty; batch item failures go back on their queue. */
  async drain(): Promise<void> {
    for (let round = 0; round < 100; round += 1) {
      if (
        this.intake.length === 0 &&
        this.emailQueue.messages.length === 0 &&
        this.rawEmail.length === 0
      ) {
        return;
      }
      await this.runQueue(this.intake, async (records) =>
        this.notifier({ Records: records }, this.context()),
      );
      const emailBodies = [
        ...this.rawEmail.splice(0),
        ...this.emailQueue.messages.splice(0).map((m) => JSON.stringify(m)),
      ];
      await this.runQueue(emailBodies, async (records) =>
        this.processor({ Records: records }, this.context()),
      );
      this.rawEmail.push(...emailBodies);
    }
    throw new Error('pipeline did not drain');
  }

  private context() {
    this.invocation += 1;
    return {
      awsRequestId: `inv-${String(this.invocation)}`,
      getRemainingTimeInMillis: () => 60_000,
    };
  }

  /** Takes everything off `queue`, processes it in concurrent batches of 10, puts failures back. */
  private async runQueue(
    queue: string[],
    invoke: (records: SQSRecord[]) => Promise<{ batchItemFailures: { itemIdentifier: string }[] }>,
  ): Promise<void> {
    const records = queue.splice(0).map(sqsRecord);
    const batches: SQSRecord[][] = [];
    for (let i = 0; i < records.length; i += 10) batches.push(records.slice(i, i + 10));
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < batches.length) {
        const batch = batches[next] ?? [];
        next += 1;
        const result = await invoke(batch);
        const failed = new Set(result.batchItemFailures.map((f) => f.itemIdentifier));
        for (const r of batch) if (failed.has(r.messageId)) queue.push(r.body);
      }
    };
    await Promise.all(Array.from({ length: this.workers }, worker));
  }
}

export interface World {
  deps: ConsoleDeps;
  deliveries: InMemoryDeliveriesStore;
  deliveryLog: InMemoryDeliveryLog;
  suppressions: InMemorySuppressions;
  subscriptions: InMemorySubscriptions;
  pendingDigest: InMemoryPendingDigest;
  toggles: FakeToggles;
  queues: FakeQueues;
  mail: FakeMailbox;
  log: SafeLog;
  pipeline: Pipeline;
  localstackUp: { value: boolean };
}

export function world(env: Record<string, string> = {}): World & ReturnType<typeof createApp> {
  // Keep test output clean; the handlers log every record.
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const deliveries = new InMemoryDeliveriesStore();
  const deliveryLog = new InMemoryDeliveryLog();
  const suppressions = new InMemorySuppressions();
  const subscriptions = new InMemorySubscriptions();
  const pendingDigest = new InMemoryPendingDigest();
  const toggles = new FakeToggles();
  const queues = new FakeQueues();
  const mail = new FakeMailbox();
  const log = new SafeLog(new Logger({ serviceName: 'console-api-test', logLevel: 'ERROR' }));
  const localstackUp = { value: true };
  const partial = {
    deliveries,
    deliveryLog,
    suppressions,
    subscriptions,
    pendingDigest,
    toggles,
    queues,
    mail,
    log,
    localstackUp,
  };
  const w = partial as World;
  const pipeline = new Pipeline(w);
  w.pipeline = pipeline;

  const config = loadConfig({
    AWS_ENDPOINT_URL: 'http://localstack:4566',
    TOGGLE_CACHE_TTL_SECONDS: '5',
    SCENARIO_WAIT_SECONDS: '30',
    ...env,
  });
  const deps: ConsoleDeps = {
    config,
    deliveries,
    deliveriesAdmin: {
      list: () => Promise.resolve([...deliveries.items.values()]),
      clear: () => {
        const n = deliveries.items.size;
        deliveries.items.clear();
        return Promise.resolve(n);
      },
    },
    deliveryLog,
    deliveryLogAdmin: {
      events: (id) => Promise.resolve(deliveryLog.items.filter((item) => item.deliveryId === id)),
      clear: () => {
        const n = deliveryLog.items.length;
        deliveryLog.items.length = 0;
        return Promise.resolve(n);
      },
    },
    suppressions,
    suppressionsAdmin: {
      list: () => Promise.resolve([...suppressions.items.values()]),
      clear: (keep: (record: SuppressionRecord) => boolean) => {
        let n = 0;
        for (const [key, value] of suppressions.items) {
          if (!keep(value)) {
            suppressions.items.delete(key);
            n += 1;
          }
        }
        return Promise.resolve(n);
      },
    },
    subscriptions,
    subscriptionsAdmin: {
      count: () => Promise.resolve(subscriptions.items.size),
      clear: () => {
        const n = subscriptions.items.size;
        subscriptions.items.clear();
        return Promise.resolve(n);
      },
    },
    pendingDigest,
    pendingDigestAdmin: {
      count: () => Promise.resolve(pendingDigest.items.size),
      clear: () => {
        const n = pendingDigest.items.size;
        pendingDigest.items.clear();
        return Promise.resolve(n);
      },
    },
    queues,
    toggles,
    mail,
    publisher: pipeline,
    emailQueue: pipeline.emailQueue,
    localstackPing: () => Promise.resolve(localstackUp.value),
    log,
    clock: () => NOW,
    sleep: () => Promise.resolve(),
  };
  w.deps = deps;
  return { ...w, ...createApp(deps) };
}

export async function call(
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await app.request(`/api/v1${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: typeof body === 'string' ? body : JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }),
  });
  const text = await response.text();
  return { status: response.status, json: text === '' ? undefined : (JSON.parse(text) as unknown) };
}

import { describe, expect, it, vi } from 'vitest';
import {
  DeliveryStatus,
  ToggleCache,
  emailHash,
  epochSeconds,
  immediateDeliveryId,
} from '@mail/core';
import type { EmailMessage } from '@mail/core';
import {
  InMemoryAccountSuppressionList,
  InMemoryDeliveriesStore,
  InMemoryDeliveryLog,
  InMemorySuppressions,
  MemoryTransport,
  StaticToggleSource,
  awsError,
} from '@mail/core/testing';
import { createProcessor } from '../src/app/processor.js';
import type { ProcessorDeps } from '../src/app/processor.js';
import {
  CountingTelemetry,
  FIXED_NOW,
  captureOutput,
  context,
  powertoolsTelemetry,
  sqsEvent,
  testLog,
} from './helpers.js';

const TO = 'ada@example.test';

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    deliveryId: immediateDeliveryId('u-123', 'report_ready', 'rep-77'),
    userId: 'u-123',
    to: TO,
    templateId: 'report_ready',
    subject: 'Your report "Q3 usage" is ready',
    text: 'Hello, your report is ready',
    html: '<p>Hello, your report is ready</p>',
    category: 'report_ready',
    kind: 'immediate',
    requestIds: ['6f1c2a40-3b7e-4c1d-9a8e-2f4b5c6d7e8f'],
    redact: false,
    createdAt: '2026-10-23T07:29:00Z',
    ...overrides,
  };
}

function setup(overrides: Partial<ProcessorDeps> = {}, toggles: Record<string, string> = {}) {
  const output = captureOutput();
  const deliveries = new InMemoryDeliveriesStore();
  const deliveryLog = new InMemoryDeliveryLog();
  const suppressions = new InMemorySuppressions();
  const transport = new MemoryTransport();
  const telemetry = new CountingTelemetry();
  const toggleSource = new StaticToggleSource({
    'send-emails': 'enabled',
    'record-deliveries': 'enabled',
    ...toggles,
  });
  const deps: ProcessorDeps = {
    deliveries,
    deliveryLog,
    suppressions,
    transport,
    toggles: new ToggleCache(toggleSource),
    log: testLog(),
    telemetry,
    fromAddress: 'notifications@example.test',
    hardDisabled: 'false',
    clock: () => FIXED_NOW,
    ...overrides,
  };
  return {
    deps,
    run: createProcessor(deps),
    deliveries,
    deliveryLog,
    suppressions,
    transport,
    telemetry,
    toggleSource,
    output,
  };
}

const ID = message().deliveryId;

describe('processor: happy path', () => {
  it('claims, sends with tags and the configuration, marks SENT, records the log', async () => {
    const { run, deliveries, deliveryLog, transport, telemetry } = setup();
    const result = await run(sqsEvent(message()), context());
    expect(result.batchItemFailures).toEqual([]);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      from: 'notifications@example.test',
      to: TO,
      tags: { deliveryId: ID, category: 'report_ready' },
    });
    expect(deliveries.items.get(ID)).toMatchObject({
      status: DeliveryStatus.SENT,
      sesMessageId: 'msg-1',
    });
    expect(deliveryLog.events(ID)).toEqual(['claimed', 'sent']);
    expect(telemetry.get('EmailsSent')).toBe(1);
    expect(telemetry.get('MessagesReceived')).toBe(1);
    expect(telemetry.flushes).toBe(1);
  });

  it('stores descriptive, masked meta with the claim (for listing deliveries)', async () => {
    const { run, deliveries } = setup();
    await run(sqsEvent(message()), context());
    expect(deliveries.items.get(ID)).toMatchObject({
      userId: 'u-123',
      category: 'report_ready',
      kind: 'immediate',
      toMasked: 'a***@example.test',
    });
    expect(JSON.stringify(deliveries.items.get(ID))).not.toContain(TO);
  });

  it('uses the invocation request id as the lease owner', async () => {
    const { run, deliveries } = setup();
    const complete = vi.fn(deliveries.complete.bind(deliveries));
    deliveries.complete = complete;
    await run(sqsEvent(message()), context(60_000, 'invocation-42'));
    expect(complete).toHaveBeenCalledWith(ID, 'invocation-42', FIXED_NOW, expect.anything());
  });
});

describe('processor: invalid input is permanent', () => {
  it.each([
    ['not JSON', '{oops'],
    ['schema', { ...message(), deliveryId: 'short' }],
    ['schema: bad address', { ...message(), to: 'nobody' }],
  ])('%s -> dropped with InvalidMessages, never retried', async (_label, body) => {
    const { run, transport, telemetry } = setup();
    const result = await run(sqsEvent(body), context());
    expect(result.batchItemFailures).toEqual([]);
    expect(transport.sent).toHaveLength(0);
    expect(telemetry.get('InvalidMessages')).toBe(1);
  });

  it('size limits -> SKIPPED(invalid:...)', async () => {
    const { run, transport, deliveries } = setup();
    await run(sqsEvent(message({ subject: 's'.repeat(999) })), context());
    expect(transport.sent).toHaveLength(0);
    expect(deliveries.items.get(ID)).toMatchObject({
      status: DeliveryStatus.SKIPPED,
      reason: 'invalid:subject_too_long',
    });
  });
});

describe('processor: oversized messages are permanent', () => {
  it.each([
    ['html over 200 KiB', { html: 'x'.repeat(200 * 1024 + 1) }, 'invalid:html_too_large'],
    ['text over 200 KiB', { text: 'é'.repeat(100 * 1024 + 1) }, 'invalid:text_too_large'],
    [
      'whole message over 500 KiB',
      {
        text: 't'.repeat(190 * 1024),
        html: 'h'.repeat(190 * 1024),
        subject: 's'.repeat(900),
        requestIds: Array.from({ length: 4000 }, () => '6f1c2a40-3b7e-4c1d-9a8e-2f4b5c6d7e8f'),
      },
      'invalid:message_too_large',
    ],
  ])('%s -> SKIPPED, not sent, not retried', async (_label, patch, reason) => {
    const { run, transport, deliveries, telemetry } = setup();
    const result = await run(sqsEvent(message(patch)), context());
    expect(result.batchItemFailures).toEqual([]);
    expect(transport.sent).toHaveLength(0);
    expect(deliveries.items.get(ID)).toMatchObject({ status: DeliveryStatus.SKIPPED, reason });
    expect(telemetry.get('InvalidMessages')).toBe(1);
  });
});

describe('processor: kill switches', () => {
  it.each([undefined, '', 'true', 'FALSE', 'False', '0', 'off'])(
    'SENDING_HARD_DISABLED=%j -> SKIPPED(disabled), nothing sent',
    async (value) => {
      const { run, transport, deliveries, telemetry } = setup({ hardDisabled: value });
      const result = await run(sqsEvent(message()), context());
      expect(result.batchItemFailures).toEqual([]);
      expect(transport.sent).toHaveLength(0);
      expect(deliveries.items.get(ID)).toMatchObject({
        status: DeliveryStatus.SKIPPED,
        reason: 'disabled',
      });
      expect(telemetry.get('EmailsSkipped')).toBe(1);
    },
  );

  it('SSM send-emails other than "enabled" -> SKIPPED(disabled)', async () => {
    const { run, transport } = setup({}, { 'send-emails': 'disabled' });
    await run(sqsEvent(message()), context());
    expect(transport.sent).toHaveLength(0);
  });

  it('SSM unreachable with no cache -> fail safe (disabled)', async () => {
    const { run, transport, toggleSource } = setup();
    toggleSource.failWith = new Error('ssm down');
    await run(sqsEvent(message()), context());
    expect(transport.sent).toHaveLength(0);
  });

  it('record-deliveries disabled -> no delivery-log rows, still sends', async () => {
    const { run, transport, deliveryLog } = setup({}, { 'record-deliveries': 'disabled' });
    await run(sqsEvent(message()), context());
    expect(transport.sent).toHaveLength(1);
    expect(deliveryLog.items).toHaveLength(0);
  });
});

describe('processor: suppression', () => {
  it('table hit -> SKIPPED(suppressed)', async () => {
    const { run, transport, suppressions, deliveries, telemetry } = setup();
    await suppressions.upsert({
      emailHash: emailHash(TO),
      reason: 'bounce_permanent',
      source: 'ses-bounce',
      at: FIXED_NOW,
    });
    const result = await run(sqsEvent(message()), context());
    expect(result.batchItemFailures).toEqual([]);
    expect(transport.sent).toHaveLength(0);
    expect(deliveries.items.get(ID)).toMatchObject({
      status: DeliveryStatus.SKIPPED,
      reason: 'suppressed',
    });
    expect(telemetry.get('Suppressed')).toBe(1);
  });

  it('SES account list hit -> SKIPPED(suppressed)', async () => {
    const { run, transport } = setup({
      accountSuppressions: new InMemoryAccountSuppressionList(new Set([TO])),
    });
    await run(sqsEvent(message()), context());
    expect(transport.sent).toHaveLength(0);
  });

  it('lookup failure -> batch item failure (never mail an address we could not check)', async () => {
    const { run, transport, suppressions } = setup();
    suppressions.failWith = new Error('dynamo down');
    const event = sqsEvent(message());
    const result = await run(event, context());
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: event.Records[0]?.messageId }]);
    expect(transport.sent).toHaveLength(0);
  });
});

describe('processor: claim outcomes', () => {
  it('duplicate (already SENT) -> dropped as success, not resent', async () => {
    const { run, transport, telemetry } = setup();
    await run(sqsEvent(message()), context());
    const second = await run(sqsEvent(message()), context(60_000, 'req-2'));
    expect(second.batchItemFailures).toEqual([]);
    expect(transport.sent).toHaveLength(1);
    expect(telemetry.get('DuplicatesSuppressed')).toBe(1);
  });

  it('the same message twice in one batch is sent once', async () => {
    const { run, transport } = setup();
    const result = await run(sqsEvent(message(), message()), context());
    expect(result.batchItemFailures).toEqual([]);
    expect(transport.sent).toHaveLength(1);
  });

  it('claim held by another worker -> batch item failure (retry later)', async () => {
    const { run, transport, deliveries, telemetry } = setup();
    deliveries.items.set(ID, {
      deliveryId: ID,
      status: DeliveryStatus.CLAIMED,
      attempts: 0,
      leaseOwner: 'other',
      leaseUntil: epochSeconds(FIXED_NOW) + 60,
      updatedAt: '',
      expiresAt: 0,
    });
    const event = sqsEvent(message());
    const result = await run(event, context());
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: event.Records[0]?.messageId }]);
    expect(transport.sent).toHaveLength(0);
    expect(telemetry.get('ClaimContention')).toBe(1);
  });

  it('expired claim -> AMBIGUOUS, alarmed, never resent', async () => {
    const { run, transport, deliveries, telemetry, deliveryLog } = setup();
    deliveries.items.set(ID, {
      deliveryId: ID,
      status: DeliveryStatus.CLAIMED,
      attempts: 0,
      leaseOwner: 'crashed',
      leaseUntil: epochSeconds(FIXED_NOW) - 1,
      updatedAt: '',
      expiresAt: 0,
    });
    const result = await run(sqsEvent(message()), context());
    expect(result.batchItemFailures).toEqual([]);
    expect(transport.sent).toHaveLength(0);
    expect(deliveries.items.get(ID)?.status).toBe(DeliveryStatus.AMBIGUOUS);
    expect(telemetry.get('AmbiguousDeliveries')).toBe(1);
    expect(deliveryLog.events(ID)).toEqual(['ambiguous']);
  });

  it('a deliveries outage before sending -> retry, nothing sent', async () => {
    const { run, transport, deliveries } = setup();
    deliveries.failNext.claim = new Error('ProvisionedThroughputExceededException');
    const result = await run(sqsEvent(message()), context());
    expect(result.batchItemFailures).toHaveLength(1);
    expect(transport.sent).toHaveLength(0);
  });
});

describe('processor: send errors', () => {
  it('transient (throttling) -> RELEASED, batch item failure, then a later attempt sends', async () => {
    const { run, transport, deliveries, telemetry } = setup();
    transport.failWith(awsError('TooManyRequestsException', 429));
    const event = sqsEvent(message());
    const first = await run(event, context(60_000, 'req-1'));
    expect(first.batchItemFailures).toEqual([{ itemIdentifier: event.Records[0]?.messageId }]);
    expect(deliveries.items.get(ID)).toMatchObject({
      status: DeliveryStatus.RELEASED,
      attempts: 1,
    });
    expect(telemetry.get('TransientFailures')).toBe(1);

    const second = await run(event, context(60_000, 'req-2'));
    expect(second.batchItemFailures).toEqual([]);
    expect(transport.sent).toHaveLength(1);
    expect(deliveries.items.get(ID)).toMatchObject({ status: DeliveryStatus.SENT, attempts: 1 });
  });

  it('SES 5xx -> transient', async () => {
    const { run, transport } = setup();
    transport.failWith(awsError('InternalFailure', 500));
    expect((await run(sqsEvent(message()), context())).batchItemFailures).toHaveLength(1);
  });

  it.each(['MessageRejected', 'MailFromDomainNotVerifiedException', 'AccountSuspendedException'])(
    '%s -> FAILED_PERMANENT, no retry',
    async (name) => {
      const { run, transport, deliveries, telemetry } = setup();
      transport.failWith(awsError(name, 400, `${name}: <${TO}>`));
      const result = await run(sqsEvent(message()), context());
      expect(result.batchItemFailures).toEqual([]);
      expect(deliveries.items.get(ID)).toMatchObject({
        status: DeliveryStatus.FAILED_PERMANENT,
        reason: name,
      });
      expect(telemetry.get('PermanentFailures')).toBe(1);
    },
  );

  it('lost response (client timeout) -> AMBIGUOUS, no retry: it may already be delivered', async () => {
    const { run, transport, deliveries, telemetry } = setup();
    const timeout = new Error('socket timed out');
    timeout.name = 'TimeoutError';
    transport.failWith(timeout);
    const result = await run(sqsEvent(message()), context());
    expect(result.batchItemFailures).toEqual([]);
    expect(deliveries.items.get(ID)?.status).toBe(DeliveryStatus.AMBIGUOUS);
    expect(telemetry.get('AmbiguousDeliveries')).toBe(1);
  });

  it('a failing release still reports the record for retry', async () => {
    const { run, transport, deliveries } = setup();
    transport.failWith(awsError('ThrottlingException', 400));
    deliveries.failNext.complete = new Error('dynamo down');
    const result = await run(sqsEvent(message()), context());
    expect(result.batchItemFailures).toHaveLength(1);
  });
});

describe('processor: nothing after SES accepted may throw', () => {
  it('mark failure (throw) -> logged + MarkFailures, record still succeeds', async () => {
    const { run, transport, deliveries, telemetry } = setup();
    deliveries.failNext.complete = new Error('dynamo down');
    const result = await run(sqsEvent(message()), context());
    expect(result.batchItemFailures).toEqual([]);
    expect(transport.sent).toHaveLength(1);
    expect(telemetry.get('MarkFailures')).toBe(1);
  });

  it('mark condition failure (lease lost) -> MarkFailures, record still succeeds', async () => {
    const { run, deliveries, telemetry } = setup();
    deliveries.complete = () => Promise.resolve(false);
    expect((await run(sqsEvent(message()), context())).batchItemFailures).toEqual([]);
    expect(telemetry.get('MarkFailures')).toBe(1);
  });

  it('metrics and delivery-log failures after send change nothing', async () => {
    const { run, transport, deliveryLog, telemetry } = setup();
    const original = telemetry.count.bind(telemetry);
    telemetry.count = (name, value) => {
      if (name === 'EmailsSent') throw new Error('metrics broken');
      original(name, value);
    };
    deliveryLog.failWith = new Error('ValidationException: item too large');
    const result = await run(sqsEvent(message()), context());
    expect(result.batchItemFailures).toEqual([]);
    expect(transport.sent).toHaveLength(1);
  });

  it('a throwing metrics flush (real Powertools) never changes the outcome', async () => {
    const log = testLog();
    const { telemetry, metrics } = powertoolsTelemetry(log);
    vi.spyOn(metrics, 'publishStoredMetrics').mockImplementation(() => {
      throw new Error('EMF serialisation failed');
    });
    const { run, transport } = setup({ telemetry, log });
    const result = await run(sqsEvent(message()), context());
    expect(result.batchItemFailures).toEqual([]);
    expect(transport.sent).toHaveLength(1);
  });
});

describe('processor: deadline guard', () => {
  it('below 30 s remaining nothing is picked up; every record is handed back', async () => {
    const { run, transport } = setup();
    const event = sqsEvent(message(), message({ deliveryId: 'f'.repeat(64) }));
    const result = await run(event, context(29_999));
    expect(result.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(
      event.Records.map((r) => r.messageId),
    );
    expect(transport.sent).toHaveLength(0);
  });

  it('stops mid-batch when time runs out', async () => {
    let remaining = 45_000;
    const { run, transport } = setup();
    transport.onSend = () => {
      remaining -= 10_000;
    };
    const ids = ['1', '2', '3'].map((d) => d.repeat(64));
    const event = sqsEvent(...ids.map((deliveryId) => message({ deliveryId })));
    const result = await run(
      event,
      context(() => remaining),
    );
    expect(transport.sent).toHaveLength(2);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: event.Records[2]?.messageId }]);
  });
});

describe('processor: logging', () => {
  it('redact=true keeps the subject out of the logs', async () => {
    const { run, output } = setup();
    await run(
      sqsEvent(message({ redact: true, subject: 'Payment failed for invoice INV-SECRET' })),
      context(),
    );
    expect(output.text()).not.toContain('INV-SECRET');
  });
});

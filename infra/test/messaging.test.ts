import { TIMEOUTS } from '../lib/constants';
import { type Json, ofType, props, refId, stringify, synth, type Statement, text } from './helpers';

const s = synth();
const queues = ofType(s.resources, 'AWS::SQS::Queue');
const keyId = ofType(s.resources, 'AWS::KMS::Key')[0]?.[0];
const queueName = (id: string): string => text(props(s.resources[id] ?? { Type: '' }).QueueName);
const policiesFor = (queueId: string): Statement[] =>
  ofType(s.resources, 'AWS::SQS::QueuePolicy')
    .filter(([, r]) => (props(r).Queues as Json[]).some((q) => refId(q) === queueId))
    .flatMap(
      ([, r]) => (props(r).PolicyDocument as unknown as { Statement: Statement[] }).Statement,
    );

describe('queues', () => {
  it('has the work queues and every DLQ', () => {
    expect(queues.map(([id]) => queueName(id)).sort()).toEqual(
      ['digest-dlq', 'email', 'email-dlq', 'events-dlq', 'intake', 'intake-dlq'].map(
        (n) => `mail-dev-${n}`,
      ),
    );
  });

  it.each(queues.map(([id]) => [queueName(id), id]))(
    '%s is encrypted with the stack CMK, TLS-only, 14 d',
    (_n, id) => {
      const q = props(s.resources[id] ?? { Type: '' });
      expect(refId(q.KmsMasterKeyId)).toBe(keyId);
      expect(q.MessageRetentionPeriod).toBe(14 * 24 * 3600);
      const deny = policiesFor(id).find((st) => st.Effect === 'Deny');
      expect(deny?.Condition).toEqual({ Bool: { 'aws:SecureTransport': 'false' } });
    },
  );

  it.each([
    ['intake', TIMEOUTS.notifierImmediate.toSeconds(), 'notifier-immediate'],
    ['email', TIMEOUTS.processor.toSeconds(), 'processor'],
  ])(
    '%s queue: DLQ after 3 receives, visibility >= 6 x the consumer timeout',
    (name, timeout, consumer) => {
      const [id, queue] = queues.find(([qid]) => queueName(qid) === `mail-dev-${name}`) ?? [
        '',
        { Type: '' },
      ];
      const q = props(queue);
      const redrive = q.RedrivePolicy as { deadLetterTargetArn: Json; maxReceiveCount: number };
      expect(redrive.maxReceiveCount).toBe(3);
      expect(queueName(refId(redrive.deadLetterTargetArn) ?? '')).toBe(`mail-dev-${name}-dlq`);
      expect(q.VisibilityTimeout).toBeGreaterThanOrEqual(6 * timeout);

      // The queue is consumed by exactly the function whose timeout the visibility is derived from.
      const mappings = ofType(s.resources, 'AWS::Lambda::EventSourceMapping').filter(
        ([, m]) => refId(props(m).EventSourceArn) === id,
      );
      expect(mappings).toHaveLength(1);
      const fn = s.resources[refId(props(mappings[0]?.[1] ?? { Type: '' }).FunctionName) ?? ''];
      expect(props(fn ?? { Type: '' }).FunctionName).toBe(`mail-dev-${consumer}`);
      expect(props(fn ?? { Type: '' }).Timeout).toBe(timeout);
    },
  );

  it('email queue caps messages at 512 KiB so a batch of 10 fits the 6 MB Lambda payload', () => {
    const size = (name: string): unknown =>
      props(queues.find(([id]) => queueName(id) === name)?.[1] ?? { Type: '' }).MaximumMessageSize;
    expect(size('mail-dev-email')).toBe(524288);
    // The DLQ keeps the default (>= the source), so a redrive can never be rejected for size.
    expect(size('mail-dev-email-dlq')).toBeUndefined();
  });

  it('event source mappings: batch 10, 5 s window, partial batch responses; processor concurrency capped', () => {
    const mappings = ofType(s.resources, 'AWS::Lambda::EventSourceMapping').map(([, m]) =>
      props(m),
    );
    expect(mappings).toHaveLength(2);
    for (const m of mappings) {
      expect(m.BatchSize).toBe(10);
      expect(m.MaximumBatchingWindowInSeconds).toBe(5);
      expect(m.FunctionResponseTypes).toEqual(['ReportBatchItemFailures']);
    }
    expect(
      mappings.filter((m) => stringify(m.ScalingConfig) === '{"MaximumConcurrency":2}'),
    ).toHaveLength(1);
  });
});

describe('bus and intake rule', () => {
  const [ruleId, rule] = ofType(s.resources, 'AWS::Events::Rule').find(([, r]) =>
    stringify(props(r).Name).includes('notification-requested'),
  ) ?? ['', { Type: '' }];

  it('routes notification.requested from the app bus to the intake queue with input path $.detail', () => {
    const r = props(rule);
    expect(r.EventPattern).toEqual({ 'detail-type': ['notification.requested'] });
    expect(props(s.resources[refId(r.EventBusName) ?? ''] ?? { Type: '' }).Name).toBe(
      'mail-dev-app-events',
    );
    const [target] = r.Targets as unknown as JsonTarget[];
    expect(queueName(refId(target?.Arn) ?? '')).toBe('mail-dev-intake');
    expect(target?.InputPath).toBe('$.detail');
    expect(queueName(refId(target?.DeadLetterConfig?.Arn) ?? '')).toBe('mail-dev-events-dlq');
    expect(ruleId).not.toBe('');
  });

  it('intake queue policy lets only this rule send', () => {
    const intakeId = queues.find(([id]) => queueName(id) === 'mail-dev-intake')?.[0] ?? '';
    const allows = policiesFor(intakeId).filter((st) => st.Effect === 'Allow');
    expect(allows).toHaveLength(1);
    expect(allows[0]?.Action).toBe('sqs:SendMessage');
    expect(stringify(allows[0]?.Condition)).toContain(
      ':rule/mail-dev-app-events/mail-dev-notification-requested',
    );
  });

  it('EventBridge may use the key only on behalf of the two rules', () => {
    const key = props(s.resources[keyId ?? ''] ?? { Type: '' });
    const stmts = (key.KeyPolicy as unknown as { Statement: (Statement & { Principal: Json })[] })
      .Statement;
    const forEvents = stmts.filter((st) =>
      stringify(st.Principal).includes('events.amazonaws.com'),
    );
    expect(forEvents.map((st) => st.Sid).sort()).toEqual(['AllowFeedbackRule', 'AllowIntakeRule']);
    for (const st of forEvents) expect(Object.keys(st.Condition ?? {})).toEqual(['ArnEquals']);
  });
});

interface JsonTarget {
  Arn: Json;
  InputPath?: string;
  DeadLetterConfig?: { Arn: Json };
}

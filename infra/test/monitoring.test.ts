import { Match } from 'aws-cdk-lib/assertions';
import { ofType, PROD, props, refId, synth, text } from './helpers';

const s = synth();
const alarms = Object.fromEntries(
  ofType(s.resources, 'AWS::CloudWatch::Alarm').map(([, r]) => [
    text(props(r).AlarmName),
    props(r),
  ]),
);
const alarm = (name: string) => {
  const a = alarms[`mail-dev-${name}`];
  if (!a) throw new Error(`alarm ${name} missing`);
  return a;
};

describe('monitoring', () => {
  it('alarm topic is KMS-encrypted and TLS-only', () => {
    const [topicId, topic] = ofType(s.resources, 'AWS::SNS::Topic')[0] ?? ['', { Type: '' }];
    expect(refId(props(topic).KmsMasterKeyId)).toBe(ofType(s.resources, 'AWS::KMS::Key')[0]?.[0]);
    s.template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      Topics: [{ Ref: topicId }],
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('subscribes alarmEmail when given', () => {
    expect(ofType(s.resources, 'AWS::SNS::Subscription')).toHaveLength(0);
    synth(PROD).template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.test',
    });
  });

  it.each([
    'email-dlq-not-empty',
    'intake-dlq-not-empty',
    'events-dlq-not-empty',
    'digest-dlq-not-empty',
  ])('%s: any visible message alarms', (name) => {
    const a = alarm(name);
    expect(a).toMatchObject({
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Namespace: 'AWS/SQS',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  it('email queue age > 15 minutes', () => {
    expect(alarm('email-queue-age')).toMatchObject({
      MetricName: 'ApproximateAgeOfOldestMessage',
      Threshold: 900,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  it.each([
    ['ambiguous-deliveries', 'AmbiguousDeliveries', 0],
    ['mark-failures', 'MarkFailures', 0],
    ['permanent-failures-spike', 'PermanentFailures', 9],
  ])('%s on the custom metric %s', (name, metric, threshold) => {
    expect(alarm(name)).toMatchObject({
      Namespace: 'EmailDelivery',
      MetricName: metric,
      Threshold: threshold,
      Dimensions: [{ Name: 'service', Value: 'mail-dev-processor' }],
    });
  });

  it('SES reputation alarms fire at the AWS review levels (5 % / 0.1 %)', () => {
    expect(alarm('bounce-rate')).toMatchObject({
      Namespace: 'AWS/SES',
      MetricName: 'Reputation.BounceRate',
      Threshold: 0.05,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
    expect(alarm('complaint-rate')).toMatchObject({
      MetricName: 'Reputation.ComplaintRate',
      Threshold: 0.001,
    });
  });

  it('function errors (incl. digest) and processor throttles', () => {
    for (const n of [
      'processor-errors',
      'digest-errors',
      'feedback-errors',
      'notifier-immediate-errors',
    ]) {
      expect(alarm(n)).toMatchObject({
        Namespace: 'AWS/Lambda',
        MetricName: 'Errors',
        Threshold: 0,
      });
    }
    expect(alarm('processor-throttles')).toMatchObject({ MetricName: 'Throttles' });
  });

  it('every alarm notifies the topic on ALARM and OK, and treats missing data as fine', () => {
    for (const a of Object.values(alarms)) {
      expect(a.AlarmActions).toHaveLength(1);
      expect(a.OKActions).toHaveLength(1);
      expect(a.TreatMissingData).toBe('notBreaching');
    }
  });

  it('one dashboard', () => {
    expect(ofType(s.resources, 'AWS::CloudWatch::Dashboard')).toHaveLength(1);
  });
});

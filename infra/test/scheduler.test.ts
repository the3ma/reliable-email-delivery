import { functionByName, ofType, props, stringify, synth, text } from './helpers';

interface Target {
  Input: string;
  RoleArn: Parameters<typeof stringify>[0];
  RetryPolicy: unknown;
  DeadLetterConfig?: unknown;
}

describe('digest schedules', () => {
  const s = synth();
  const schedules = ofType(s.resources, 'AWS::Scheduler::Schedule').map(([, r]) => props(r));
  const target = (p: (typeof schedules)[number]): Target => p.Target as unknown as Target;

  it('creates exactly `segments` (16) schedules in one group', () => {
    expect(schedules).toHaveLength(16);
    expect(ofType(s.resources, 'AWS::Scheduler::ScheduleGroup')).toHaveLength(1);
    expect(new Set(schedules.map((p) => p.GroupName))).toEqual(new Set(['mail-dev-digest']));
  });

  it('each schedule carries its own payload {segment:n}, n = 0..15', () => {
    const payloads = schedules.map((p) => JSON.parse(target(p).Input) as Record<string, number>);
    expect(payloads.map((x) => x.segment).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      ...Array(16).keys(),
    ]);
    for (const x of payloads) expect(Object.keys(x)).toEqual(['segment']);
  });

  it('no retries, 5 minute max event age, flexible window off, DLQ set', () => {
    for (const p of schedules) {
      expect(target(p).RetryPolicy).toEqual({
        MaximumRetryAttempts: 0,
        MaximumEventAgeInSeconds: 300,
      });
      expect(target(p).DeadLetterConfig).toBeDefined();
      expect(p.FlexibleTimeWindow).toEqual({ Mode: 'OFF' });
    }
  });

  it('staggers the segments across the hour (distinct minutes, hourly by default)', () => {
    const minutes = schedules.map((p) =>
      Number(/^cron\((\d+) \* \* \* \? \*\)$/.exec(text(p.ScheduleExpression))?.[1]),
    );
    expect(new Set(minutes).size).toBe(16);
    expect(Math.max(...minutes)).toBeLessThan(60);
  });

  it('all schedules share one scheduler role', () => {
    expect(new Set(schedules.map((p) => stringify(target(p).RoleArn))).size).toBe(1);
    const schedulerRoles = ofType(s.resources, 'AWS::IAM::Role').filter(([, r]) =>
      stringify(props(r).AssumeRolePolicyDocument).includes('scheduler.amazonaws.com'),
    );
    expect(schedulerRoles).toHaveLength(1);
  });

  it('the digest function itself does not retry async invocations', () => {
    const [digestId] = functionByName(s, 'notifier-digest');
    s.template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      FunctionName: { Ref: digestId },
      MaximumRetryAttempts: 0,
    });
  });

  it('honours segments and digestWindow from context', () => {
    const custom = synth({ segments: 4, digestWindow: '4-10' });
    const expressions = ofType(custom.resources, 'AWS::Scheduler::Schedule').map(([, r]) =>
      text(props(r).ScheduleExpression),
    );
    expect(expressions.sort()).toEqual([
      'cron(0 4-10 * * ? *)',
      'cron(15 4-10 * * ? *)',
      'cron(30 4-10 * * ? *)',
      'cron(45 4-10 * * ? *)',
    ]);
  });
});

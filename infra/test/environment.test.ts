import { functionByName, ofType, props, synth } from './helpers';

const s = synth();
const env = (name: string): Record<string, unknown> =>
  (props(functionByName(s, name)[1]).Environment as { Variables: Record<string, unknown> })
    .Variables;

const POWERTOOLS = ['POWERTOOLS_SERVICE_NAME', 'POWERTOOLS_METRICS_NAMESPACE', 'LOG_LEVEL'];

// CONTRACT section 8: each function gets exactly what it uses, nothing more.
const expected: Record<string, string[]> = {
  'notifier-immediate': [
    'TABLE_SUBSCRIPTIONS',
    'TABLE_PENDING_DIGEST',
    'TABLE_DELIVERIES',
    'EMAIL_QUEUE_URL',
    'APP_BASE_URL',
  ],
  'notifier-digest': [
    'TABLE_SUBSCRIPTIONS',
    'TABLE_PENDING_DIGEST',
    'TABLE_DELIVERIES',
    'EMAIL_QUEUE_URL',
    'APP_BASE_URL',
    'SEGMENTS',
  ],
  processor: [
    'TABLE_DELIVERIES',
    'TABLE_DELIVERY_LOG',
    'TABLE_SUPPRESSIONS',
    'FROM_ADDRESS',
    'SES_CONFIGURATION_SET',
    'MAIL_TRANSPORT',
    'SSM_PREFIX',
    'SENDING_HARD_DISABLED',
  ],
  feedback: ['TABLE_SUPPRESSIONS', 'TABLE_DELIVERY_LOG'],
};

describe('function environment', () => {
  it.each(Object.entries(expected))('%s has exactly the contract variables', (name, vars) => {
    expect(Object.keys(env(name)).sort()).toEqual([...vars, ...POWERTOOLS].sort());
  });

  it('Powertools: namespace EmailDelivery, one service name per function', () => {
    const names = Object.keys(expected).map((n) => env(n).POWERTOOLS_SERVICE_NAME);
    expect(names).toEqual(Object.keys(expected).map((n) => `mail-dev-${n}`));
    for (const n of Object.keys(expected))
      expect(env(n).POWERTOOLS_METRICS_NAMESPACE).toBe('EmailDelivery');
  });

  it('processor values: SES transport, toggle path, hard switch off by default', () => {
    const p = env('processor');
    expect(p.MAIL_TRANSPORT).toBe('ses');
    expect(p.SSM_PREFIX).toBe('/mail-dev/email/');
    expect(p.SENDING_HARD_DISABLED).toBe('false');
    expect(p.FROM_ADDRESS).toBe('notifications@example.test');
    expect(p.SES_CONFIGURATION_SET).toBe('mail-dev-email');
    expect(env('notifier-digest').SEGMENTS).toBe('16');
  });

  it('sendingHardDisabled=true sets the hard switch', () => {
    const hard = synth({ sendingHardDisabled: true });
    const vars = (
      props(functionByName(hard, 'processor')[1]).Environment as {
        Variables: Record<string, unknown>;
      }
    ).Variables;
    expect(vars.SENDING_HARD_DISABLED).toBe('true');
  });

  it('all functions: Node.js 22 on arm64 with active tracing and a retained log group', () => {
    const fns = ofType(s.resources, 'AWS::Lambda::Function');
    expect(fns).toHaveLength(4);
    for (const [, fn] of fns) {
      expect(props(fn).Runtime).toBe('nodejs22.x');
      expect(props(fn).Architectures).toEqual(['arm64']);
      expect(props(fn).TracingConfig).toEqual({ Mode: 'Active' });
      expect(props(fn).LoggingConfig).toBeDefined();
    }
    for (const [, lg] of ofType(s.resources, 'AWS::Logs::LogGroup'))
      expect(props(lg).RetentionInDays).toBe(14);
  });
});

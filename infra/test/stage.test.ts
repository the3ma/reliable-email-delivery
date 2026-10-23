import { App } from 'aws-cdk-lib';
import { ConfigError, loadConfig } from '../lib/config';
import { type Context, ofType, PROD, props, synth, text } from './helpers';

const parameter = (s: ReturnType<typeof synth>, name: string): unknown =>
  props(
    ofType(s.resources, 'AWS::SSM::Parameter').find(([, r]) =>
      text(props(r).Name).endsWith(name),
    )?.[1] ?? {
      Type: '',
    },
  ).Value;

describe('stages', () => {
  const dev = synth();
  const prod = synth(PROD);

  it('prod: send-emails starts disabled; dev starts enabled; record-deliveries enabled in both', () => {
    expect(parameter(prod, '/mail-prod/email/send-emails')).toBe('disabled');
    expect(parameter(dev, '/mail-dev/email/send-emails')).toBe('enabled');
    expect(parameter(prod, '/mail-prod/email/record-deliveries')).toBe('enabled');
  });

  it('prod: send-emails can be codified as enabled once live', () => {
    expect(
      parameter(synth({ ...PROD, sendEmails: 'enabled' }), '/mail-prod/email/send-emails'),
    ).toBe('enabled');
  });

  it('prod: termination protection, retained key, queues and logs', () => {
    expect(prod.stack.terminationProtection).toBe(true);
    expect(dev.stack.terminationProtection).toBe(false);
    for (const type of ['AWS::KMS::Key', 'AWS::SQS::Queue', 'AWS::Logs::LogGroup']) {
      for (const [, r] of ofType(prod.resources, type)) expect(r.DeletionPolicy).toBe('Retain');
    }
  });

  it('the key rotates', () => {
    for (const s of [dev, prod]) {
      s.template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    }
  });

  it('prod defaults to 90 day log retention', () => {
    for (const [, lg] of ofType(prod.resources, 'AWS::Logs::LogGroup'))
      expect(props(lg).RetentionInDays).toBe(90);
  });
});

describe('config validation', () => {
  const load = (context: Context) => () => loadConfig(new App({ context }).node);

  it.each<[string, Context]>([
    ['unknown stage', { stage: 'qa' }],
    ['prod without alarmEmail', { stage: 'prod' }],
    [
      'fromAddress outside sendingDomain',
      { sendingDomain: 'example.test', fromAddress: 'a@other.example.test' },
    ],
    ['invalid email', { fromAddress: 'not-an-address' }],
    ['bad prefix', { prefix: 'Bad_Prefix' }],
    ['processorConcurrency below the SQS minimum of 2', { processorConcurrency: 1 }],
    [
      'reservedConcurrency below processorConcurrency',
      { processorConcurrency: 5, reservedConcurrency: 4 },
    ],
    ['non-CloudWatch retention', { logRetentionDays: 10 }],
    ['too many segments', { segments: 61 }],
    ['bad digestWindow', { digestWindow: '25' }],
    ['bad boolean', { skipBundling: 'yes' }],
    ['bad toggle', { sendEmails: 'on' }],
    ['bad operator ARN', { operatorPrincipalArn: 'operator' }],
  ])('rejects %s', (_label, context) => {
    expect(load(context)).toThrow(ConfigError);
  });

  it('applies defaults', () => {
    const c = loadConfig(new App().node);
    expect(c).toMatchObject({
      stage: 'dev',
      prefix: 'mail-dev',
      fromAddress: 'notifications@example.test',
      sesIdentity: 'notifications@example.test',
      digestWindow: '*',
      segments: 16,
      processorConcurrency: 2,
      logRetentionDays: 14,
      sendingHardDisabled: false,
      sendEmails: 'enabled',
      skipBundling: false,
    });
    expect(c.reservedConcurrency).toBeUndefined();
  });

  it('accepts string context values as passed by the CLI', () => {
    const c = loadConfig(
      new App({ context: { segments: '8', skipBundling: 'true', reservedConcurrency: '10' } }).node,
    );
    expect(c).toMatchObject({ segments: 8, skipBundling: true, reservedConcurrency: 10 });
  });

  it('reservedConcurrency is applied to the processor only', () => {
    const s = synth({ reservedConcurrency: 10 });
    const reserved = ofType(s.resources, 'AWS::Lambda::Function')
      .filter(([, r]) => props(r).ReservedConcurrentExecutions !== undefined)
      .map(([, r]) => props(r).FunctionName);
    expect(reserved).toEqual(['mail-dev-processor']);
  });
});

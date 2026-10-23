import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { PROD, synth } from './helpers';

describe('cdk-nag AwsSolutions', () => {
  it.each([
    ['dev', {}],
    ['prod', PROD],
    [
      'prod with operator role and reserved concurrency',
      {
        ...PROD,
        operatorPrincipalArn: 'arn:aws:iam::111111111111:role/operator',
        reservedConcurrency: 10,
      },
    ],
  ])('%s: zero unsuppressed errors and warnings', (_name, context) => {
    const { stack } = synth(context, { nag: true });
    const annotations = Annotations.fromStack(stack);
    const findings = [
      ...annotations.findError('*', Match.stringLikeRegexp('AwsSolutions-.*')),
      ...annotations.findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*')),
    ].map((f) => `${f.id}: ${JSON.stringify(f.entry.data).slice(0, 160)}`);
    expect(findings).toEqual([]);
  });
});

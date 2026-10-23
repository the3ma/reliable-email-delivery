import { PROD, synth } from './helpers';

describe('stack outputs', () => {
  it('have the stable names the runbook refers to', () => {
    const s = synth({ ...PROD, operatorPrincipalArn: 'arn:aws:iam::111111111111:root' });
    const outputs = (s.template.toJSON() as { Outputs: Record<string, { Value: unknown }> })
      .Outputs;
    expect(Object.keys(outputs).sort()).toEqual(
      [
        'DigestDlqInspect',
        'DkimRecord1',
        'DkimRecord2',
        'DkimRecord3',
        'EmailDlqArn',
        'EmailQueueArn',
        'EmailRedrive',
        'EventsDlqInspect',
        'IntakeDlqArn',
        'IntakeQueueArn',
        'IntakeRedrive',
        'MailFromRecords',
        'OperatorRoleArn',
      ].sort(),
    );
    expect(JSON.stringify(outputs.EmailRedrive?.Value)).toContain(
      'aws sqs start-message-move-task --source-arn ',
    );
  });
});

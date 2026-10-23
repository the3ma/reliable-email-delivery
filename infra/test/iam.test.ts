import {
  actionsOf,
  asArray,
  functionStatements,
  granting,
  ofType,
  PROD,
  props,
  type Statement,
  stringify,
  synth,
  touchesTable,
} from './helpers';

const s = synth();
const processor = functionStatements(s, 'processor');
const feedback = functionStatements(s, 'feedback');

describe('processor IAM', () => {
  it('ses:SendEmail only on the identity and the configuration set, with a FromAddress condition', () => {
    const send = granting(processor, 'ses:SendEmail');
    expect(send).toHaveLength(1);
    const [st] = send as [Statement];
    const resources = asArray(st.Resource as never[]).map((r) => stringify(r));
    expect(resources).toHaveLength(2);
    expect(resources.some((r) => r.includes(':identity/notifications@example.test'))).toBe(true);
    expect(resources.some((r) => r.includes(':configuration-set/mail-dev-email'))).toBe(true);
    expect(st.Condition).toEqual({
      StringEquals: { 'ses:FromAddress': 'notifications@example.test' },
    });
  });

  it('with an owned domain, the identity is the domain', () => {
    const p = functionStatements(synth(PROD), 'processor');
    expect(stringify(granting(p, 'ses:SendEmail')[0]?.Resource)).toContain(
      ':identity/example.test"',
    );
  });

  it('no other SES action than SendEmail and the read-only suppression lookup', () => {
    const ses = actionsOf(processor).filter((a) => a.startsWith('ses:'));
    expect(new Set(ses)).toEqual(new Set(['ses:SendEmail', 'ses:GetSuppressedDestination']));
  });

  it('ssm: only GetParametersByPath on the toggle path', () => {
    const ssm = processor.filter((st) => actionsOf([st]).some((a) => a.startsWith('ssm:')));
    expect(ssm).toHaveLength(1);
    expect(actionsOf(ssm)).toEqual(['ssm:GetParametersByPath']);
    const resources = asArray(ssm[0]?.Resource as never[]).map((r) => stringify(r));
    expect(resources).toHaveLength(2);
    for (const r of resources) expect(r).toMatch(/:parameter\/mail-dev\/email(\/\*)?"/);
  });

  it('table access: deliveries get + conditional update (the claim), log put, suppressions get', () => {
    expect(touchesTable(processor, s, 'subscriptions')).toBe(false);
    expect(touchesTable(processor, s, 'pending-digest')).toBe(false);
    expect(tableActions(processor, 'deliveries')).toEqual([
      'dynamodb:GetItem',
      'dynamodb:UpdateItem',
    ]);
    expect(tableActions(processor, 'delivery-log')).toEqual(['dynamodb:PutItem']);
    expect(tableActions(processor, 'suppressions')).toEqual(['dynamodb:GetItem']);
  });
});

describe('feedback IAM', () => {
  it('can write suppressions (upsert) and the delivery log, and do nothing else on tables', () => {
    expect(tableActions(feedback, 'suppressions')).toEqual(['dynamodb:UpdateItem']);
    expect(tableActions(feedback, 'delivery-log')).toEqual(['dynamodb:PutItem']);
  });

  it('cannot read subscriptions (no access at all), nor deliveries or pending digests', () => {
    expect(touchesTable(feedback, s, 'subscriptions')).toBe(false);
    expect(touchesTable(feedback, s, 'deliveries')).toBe(false);
    expect(touchesTable(feedback, s, 'pending-digest')).toBe(false);
  });

  it('cannot send e-mail', () => {
    expect(actionsOf(feedback).filter((a) => a.startsWith('ses:'))).toEqual([]);
  });
});

describe('every policy in the stack', () => {
  const all = ofType(s.resources, 'AWS::IAM::Policy').flatMap(
    ([, r]) => (props(r).PolicyDocument as unknown as { Statement: Statement[] }).Statement,
  );

  it('has no wildcard DynamoDB, SQS, SES or SSM actions', () => {
    for (const action of actionsOf(all)) {
      if (/^(dynamodb|sqs|ses|ssm):/.test(action)) expect(action).not.toContain('*');
    }
  });

  it('has no Allow on resource * except actions that have no resource-level permissions', () => {
    const star = all.filter(
      (st) => st.Effect === 'Allow' && asArray(st.Resource as never[]).includes('*' as never),
    );
    expect(new Set(actionsOf(star))).toEqual(
      new Set([
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
        'ses:GetSuppressedDestination',
      ]),
    );
  });

  it('only the notifiers can send to the email queue', () => {
    const emailQueueId = s.stack.getLogicalId(
      s.stack.messaging.emailQueue.node.defaultChild as Parameters<typeof s.stack.getLogicalId>[0],
    );
    const sendsToEmailQueue = (name: string): boolean =>
      granting(functionStatements(s, name), 'sqs:SendMessage').some((st) =>
        stringify(st.Resource).includes(`"${emailQueueId}"`),
      );
    expect(
      ['notifier-immediate', 'notifier-digest', 'processor', 'feedback'].filter(sendsToEmailQueue),
    ).toEqual(['notifier-immediate', 'notifier-digest']);
  });

  it('functions use their own roles: no AWS managed policies', () => {
    for (const [, role] of ofType(s.resources, 'AWS::IAM::Role')) {
      expect(props(role).ManagedPolicyArns).toBeUndefined();
    }
  });
});

describe('redrive operator role', () => {
  it('is only created when operatorPrincipalArn is set and can only move DLQ messages', () => {
    expect(
      ofType(s.resources, 'AWS::IAM::Role').filter(
        ([, r]) => props(r).RoleName === 'mail-dev-dlq-redrive',
      ),
    ).toHaveLength(0);
    const withOperator = synth({ operatorPrincipalArn: 'arn:aws:iam::111111111111:role/operator' });
    const [roleId] = ofType(withOperator.resources, 'AWS::IAM::Role').find(
      ([, r]) => props(r).RoleName === 'mail-dev-dlq-redrive',
    ) ?? [''];
    expect(roleId).not.toBe('');
    const policy = ofType(withOperator.resources, 'AWS::IAM::Policy').find(([, r]) =>
      stringify(props(r).Roles).includes(`"${roleId}"`),
    );
    const actions = actionsOf(
      (props(policy?.[1] ?? { Type: '' }).PolicyDocument as unknown as { Statement: Statement[] })
        .Statement,
    );
    expect(actions.filter((a) => a.startsWith('sqs:')).sort()).toEqual(
      [
        'sqs:CancelMessageMoveTask',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes',
        'sqs:GetQueueAttributes',
        'sqs:ListMessageMoveTasks',
        'sqs:ReceiveMessage',
        'sqs:SendMessage',
        'sqs:StartMessageMoveTask',
      ].sort(),
    );
  });
});

/** Sorted DynamoDB actions the statements grant on one table. */
function tableActions(statements: Statement[], table: string): string[] {
  return actionsOf(statements.filter((st) => touchesTable([st], s, table)))
    .filter((a) => a.startsWith('dynamodb:'))
    .sort();
}

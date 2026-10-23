import {
  aws_iam as iam,
  type aws_kms as kms,
  type aws_sqs as sqs,
  CfnOutput,
  Stack,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface RedrivePair {
  readonly name: string;
  readonly dlq: sqs.IQueue;
  readonly source: sqs.IQueue;
}

export interface RedriveProps {
  readonly prefix: string;
  readonly key: kms.IKey;
  /** DLQs whose messages go back to a source queue with StartMessageMoveTask. */
  readonly pairs: RedrivePair[];
  /** DLQs fed by EventBridge / Scheduler / async Lambda: inspected and handled by hand, not moved. */
  readonly inspectOnly: { readonly name: string; readonly dlq: sqs.IQueue }[];
  readonly operatorPrincipalArn?: string;
}

/** Redrive commands as stack-level outputs (unhashed names, as the runbook refers to them), and an optional operator role that can do nothing but redrive. */
export class Redrive extends Construct {
  readonly operatorRole?: iam.Role;

  constructor(scope: Construct, id: string, props: RedriveProps) {
    super(scope, id);

    for (const { name, dlq, source } of props.pairs) {
      new CfnOutput(Stack.of(this), `${name}DlqArn`, { value: dlq.queueArn });
      new CfnOutput(Stack.of(this), `${name}QueueArn`, { value: source.queueArn });
      new CfnOutput(Stack.of(this), `${name}Redrive`, {
        description: `Move ${name} DLQ messages back after fixing the cause (safe: SENT deliveries are dropped as duplicates)`,
        value: `aws sqs start-message-move-task --source-arn ${dlq.queueArn} --destination-arn ${source.queueArn}`,
      });
    }
    for (const { name, dlq } of props.inspectOnly) {
      new CfnOutput(Stack.of(this), `${name}DlqInspect`, {
        description: `Inspect ${name} DLQ (no source queue to move back to; see the runbook)`,
        value: `aws sqs receive-message --queue-url ${dlq.queueUrl} --max-number-of-messages 10 --attribute-names All --message-attribute-names All`,
      });
    }

    if (props.operatorPrincipalArn) {
      this.operatorRole = new iam.Role(this, 'OperatorRole', {
        roleName: `${props.prefix}-dlq-redrive`,
        description: 'Can start, list and cancel DLQ message move tasks - nothing else',
        assumedBy: new iam.ArnPrincipal(props.operatorPrincipalArn),
      });
      const dlqArns = props.pairs.map((p) => p.dlq.queueArn);
      // StartMessageMoveTask runs with the caller's permissions: receive/delete on the DLQ, send on the source.
      this.operatorRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'sqs:StartMessageMoveTask',
            'sqs:ListMessageMoveTasks',
            'sqs:CancelMessageMoveTask',
            'sqs:ReceiveMessage',
            'sqs:DeleteMessage',
            'sqs:GetQueueAttributes',
          ],
          resources: dlqArns,
        }),
      );
      this.operatorRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['sqs:SendMessage', 'sqs:GetQueueAttributes'],
          resources: props.pairs.map((p) => p.source.queueArn),
        }),
      );
      props.key.grantEncryptDecrypt(this.operatorRole);
      new CfnOutput(Stack.of(this), 'OperatorRoleArn', { value: this.operatorRole.roleArn });
    }
  }
}

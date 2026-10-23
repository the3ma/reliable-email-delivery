import {
  aws_events as events,
  aws_iam as iam,
  type aws_kms as kms,
  type aws_sqs as sqs,
  Duration,
  type RemovalPolicy,
  Stack,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EMAIL_MAX_MESSAGE_BYTES, RETENTION, TIMEOUTS, visibilityFor } from '../constants';
import { encryptedQueue, queueWithDlq } from './queues';

export interface MessagingProps {
  readonly prefix: string;
  readonly key: kms.IKey;
  readonly removalPolicy: RemovalPolicy;
}

/**
 * The product-facing bus and the two work queues. The intake rule only forwards the `detail` of
 * `notification.requested`, so the intake queue body is exactly the notification request.
 */
export class Messaging extends Construct {
  readonly bus: events.EventBus;
  readonly intakeQueue: sqs.Queue;
  readonly intakeDlq: sqs.Queue;
  readonly emailQueue: sqs.Queue;
  readonly emailDlq: sqs.Queue;
  /** Events EventBridge could not deliver to a target (both rules) and failed async feedback invocations. */
  readonly eventsDlq: sqs.Queue;
  readonly intakeRuleArn: string;

  constructor(scope: Construct, id: string, props: MessagingProps) {
    super(scope, id);
    const { prefix, key, removalPolicy } = props;

    ({ queue: this.intakeQueue, dlq: this.intakeDlq } = queueWithDlq(this, 'Intake', {
      name: `${prefix}-intake`,
      key,
      removalPolicy,
      visibilityTimeout: visibilityFor(TIMEOUTS.notifierImmediate),
    }));
    ({ queue: this.emailQueue, dlq: this.emailDlq } = queueWithDlq(this, 'Email', {
      name: `${prefix}-email`,
      key,
      removalPolicy,
      visibilityTimeout: visibilityFor(TIMEOUTS.processor),
      maxMessageSizeBytes: EMAIL_MAX_MESSAGE_BYTES,
    }));
    this.eventsDlq = encryptedQueue(this, 'EventsDlq', {
      name: `${prefix}-events-dlq`,
      key,
      removalPolicy,
    });

    const busName = `${prefix}-app-events`;
    const ruleName = `${prefix}-notification-requested`;
    this.bus = new events.EventBus(this, 'Bus', { eventBusName: busName });
    // Lets a lost or mis-processed request be replayed; the delivery id makes a replay harmless.
    this.bus.archive('Archive', {
      archiveName: `${prefix}-app-events`,
      eventPattern: { detailType: ['notification.requested'] },
      retention: RETENTION,
    });

    // Built from names, not Refs: the key policy must not depend on the rule that depends on the key.
    this.intakeRuleArn = Stack.of(this).formatArn({
      service: 'events',
      resource: 'rule',
      resourceName: `${busName}/${ruleName}`,
    });
    const rule = new events.Rule(this, 'NotificationRequested', {
      ruleName,
      eventBus: this.bus,
      eventPattern: { detailType: ['notification.requested'] },
    });
    rule.addTarget(
      new EncryptedQueueTarget(this.intakeQueue, this.intakeRuleArn, {
        input: events.RuleTargetInput.fromEventPath('$.detail'),
        deadLetterQueue: this.eventsDlq,
      }),
    );
    allowEventBridgeToUseKey(key, 'AllowIntakeRule', this.intakeRuleArn);
  }
}

/**
 * Rule target for a KMS-encrypted queue. The stock SqsQueue target drops the aws:SourceArn condition
 * for encrypted queues (to avoid a Ref cycle) and grants EventBridge the key without a condition; with
 * the rule ARN built from names, both the queue policy and the key policy can name this one rule.
 */
class EncryptedQueueTarget implements events.IRuleTarget {
  constructor(
    private readonly queue: sqs.IQueue,
    private readonly ruleArn: string,
    private readonly opts: { input: events.RuleTargetInput; deadLetterQueue: sqs.IQueue },
  ) {}

  bind(): events.RuleTargetConfig {
    for (const queue of [this.queue, this.opts.deadLetterQueue]) {
      queue.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal('events.amazonaws.com')],
          actions: ['sqs:SendMessage'],
          resources: [queue.queueArn],
          conditions: { ArnEquals: { 'aws:SourceArn': this.ruleArn } },
        }),
      );
    }
    return {
      arn: this.queue.queueArn,
      input: this.opts.input,
      targetResource: this.queue,
      deadLetterConfig: { arn: this.opts.deadLetterQueue.queueArn },
      // EventBridge's maximum: a short SQS/KMS outage must not drop requests.
      retryPolicy: {
        maximumRetryAttempts: 185,
        maximumEventAgeInSeconds: Duration.hours(24).toSeconds(),
      },
    };
  }
}

/** EventBridge needs the key to put messages on a KMS-encrypted queue (target or target DLQ). */
export function allowEventBridgeToUseKey(key: kms.IKey, sid: string, ruleArn: string): void {
  key.addToResourcePolicy(
    new iam.PolicyStatement({
      sid,
      principals: [new iam.ServicePrincipal('events.amazonaws.com')],
      actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
      resources: ['*'],
      conditions: { ArnEquals: { 'aws:SourceArn': ruleArn } },
    }),
  );
}

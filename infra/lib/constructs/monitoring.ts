import {
  aws_cloudwatch as cw,
  aws_cloudwatch_actions as actions,
  aws_iam as iam,
  type aws_kms as kms,
  type aws_lambda as lambda,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
  type aws_sqs as sqs,
  Duration,
  Stack,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { METRICS_NAMESPACE } from '../constants';
import type { Functions } from './functions';
import type { Messaging } from './messaging';

export interface MonitoringProps {
  readonly prefix: string;
  readonly key: kms.IKey;
  readonly alarmEmail?: string;
  readonly messaging: Messaging;
  readonly functions: Functions;
}

/** Above this many permanent failures in 15 minutes something systematic is wrong (template, identity). */
const PERMANENT_FAILURE_SPIKE = 10;

export class Monitoring extends Construct {
  readonly topic: sns.Topic;
  readonly alarms: cw.Alarm[] = [];
  private readonly props: MonitoringProps;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);
    this.props = props;
    const { prefix, key, messaging, functions } = props;

    this.topic = new sns.Topic(this, 'Alarms', {
      topicName: `${prefix}-alarms`,
      displayName: `${prefix} e-mail delivery alarms`,
      masterKey: key,
      enforceSSL: true,
    });
    if (props.alarmEmail) this.topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    // CloudWatch publishes to the encrypted topic with its service principal.
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarmsToPublish',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': Stack.of(this).account } },
      }),
    );

    // ---- queues
    this.dlqNotEmpty(
      'email-dlq-not-empty',
      messaging.emailDlq,
      'Processor gave up on a message after 3 receives',
    );
    this.dlqNotEmpty(
      'intake-dlq-not-empty',
      messaging.intakeDlq,
      'Immediate notifier gave up on a request',
    );
    this.dlqNotEmpty(
      'events-dlq-not-empty',
      messaging.eventsDlq,
      'An event could not be delivered or processed',
    );
    this.dlqNotEmpty(
      'digest-dlq-not-empty',
      functions.digestDlq,
      'A digest segment could not be invoked or failed',
    );
    this.queueAge('email-queue-age', messaging.emailQueue);
    this.queueAge('intake-queue-age', messaging.intakeQueue);

    // ---- functions
    this.errors('processor-errors', functions.processor);
    this.errors('notifier-immediate-errors', functions.notifierImmediate);
    this.errors('digest-errors', functions.notifierDigest);
    this.errors('feedback-errors', functions.feedback);
    this.alarm(
      'processor-throttles',
      functions.processor.metricThrottles({ period: Duration.minutes(5) }),
      {
        threshold: 0,
        description:
          'Processor throttled: reserved/account concurrency below the event source maxConcurrency',
      },
    );

    // ---- business metrics (Powertools EMF, dimension `service`)
    const processorService = `${prefix}-processor`;
    this.alarm('ambiguous-deliveries', this.custom('AmbiguousDeliveries', processorService), {
      threshold: 0,
      description: 'A delivery may or may not have been sent; it is not retried. See the runbook.',
    });
    this.alarm('mark-failures', this.custom('MarkFailures', processorService), {
      threshold: 0,
      description:
        'An accepted e-mail could not be marked SENT; a redrive of it would be dropped as a duplicate claim',
    });
    this.alarm(
      'permanent-failures-spike',
      this.custom('PermanentFailures', processorService, Duration.minutes(15)),
      {
        threshold: PERMANENT_FAILURE_SPIKE - 1,
        description: `>= ${PERMANENT_FAILURE_SPIKE} permanent send failures in 15 minutes`,
      },
    );

    // ---- SES account reputation. AWS reviews an account at about 5 % bounces / 0.1 % complaints
    // and may pause sending at 10 % / 0.5 %; alarming at the review level leaves time to act.
    this.alarm('bounce-rate', this.ses('Reputation.BounceRate'), {
      threshold: 0.05,
      description: 'SES bounce rate >= 5 % (AWS review level; sending may be paused at 10 %)',
      comparison: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    this.alarm('complaint-rate', this.ses('Reputation.ComplaintRate'), {
      threshold: 0.001,
      description: 'SES complaint rate >= 0.1 % (AWS review level; sending may be paused at 0.5 %)',
      comparison: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    this.dashboard();
  }

  private alarm(
    name: string,
    metric: cw.IMetric,
    opts: { threshold: number; description: string; comparison?: cw.ComparisonOperator },
  ): cw.Alarm {
    const alarm = new cw.Alarm(this, name, {
      alarmName: `${this.props.prefix}-${name}`,
      alarmDescription: opts.description,
      metric,
      threshold: opts.threshold,
      evaluationPeriods: 1,
      comparisonOperator: opts.comparison ?? cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      // No data means nothing happened (no messages, no errors, no sends) - not a failure.
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new actions.SnsAction(this.topic));
    alarm.addOkAction(new actions.SnsAction(this.topic));
    this.alarms.push(alarm);
    return alarm;
  }

  private dlqNotEmpty(name: string, queue: sqs.IQueue, description: string): void {
    this.alarm(
      name,
      queue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(1),
        statistic: cw.Stats.MAXIMUM,
      }),
      {
        threshold: 0,
        description: `${description}. Fix the cause, then redrive (see the redrive outputs).`,
      },
    );
  }

  private queueAge(name: string, queue: sqs.IQueue): void {
    this.alarm(
      name,
      queue.metricApproximateAgeOfOldestMessage({
        period: Duration.minutes(5),
        statistic: cw.Stats.MAXIMUM,
      }),
      {
        threshold: Duration.minutes(15).toSeconds(),
        description: 'Oldest message older than 15 minutes',
      },
    );
  }

  private errors(name: string, fn: lambda.IFunction): void {
    this.alarm(name, fn.metricErrors({ period: Duration.minutes(5) }), {
      threshold: 0,
      description: `${name}: invocation errors (crash, timeout or unhandled error)`,
    });
  }

  private custom(metricName: string, service: string, period = Duration.minutes(5)): cw.Metric {
    return new cw.Metric({
      namespace: METRICS_NAMESPACE,
      metricName,
      dimensionsMap: { service },
      statistic: cw.Stats.SUM,
      period,
    });
  }

  private ses(metricName: string): cw.Metric {
    // Account-level reputation metrics (no dimensions); SES updates them roughly hourly.
    return new cw.Metric({
      namespace: 'AWS/SES',
      metricName,
      statistic: cw.Stats.MAXIMUM,
      period: Duration.hours(1),
    });
  }

  private dashboard(): void {
    const { prefix, messaging, functions } = this.props;
    const fns = [
      functions.notifierImmediate,
      functions.notifierDigest,
      functions.processor,
      functions.feedback,
    ];
    const dlqs = [
      messaging.intakeDlq,
      messaging.emailDlq,
      messaging.eventsDlq,
      functions.digestDlq,
    ];
    const service = `${prefix}-processor`;
    const graph = (title: string, metrics: cw.IMetric[], width = 8): cw.GraphWidget =>
      new cw.GraphWidget({ title, left: metrics, width, height: 6 });

    new cw.Dashboard(this, 'Dashboard', {
      dashboardName: `${prefix}-email-delivery`,
      defaultInterval: Duration.hours(24),
      widgets: [
        [new cw.AlarmStatusWidget({ title: 'Alarms', alarms: this.alarms, width: 24, height: 4 })],
        [
          graph(
            'Emails',
            ['EmailsSent', 'EmailsSkipped', 'DuplicatesSuppressed', 'Suppressed'].map((m) =>
              this.custom(m, service),
            ),
          ),
          graph(
            'Failures',
            [
              'TransientFailures',
              'PermanentFailures',
              'AmbiguousDeliveries',
              'MarkFailures',
              'InvalidMessages',
              'ClaimContention',
            ].map((m) => this.custom(m, service)),
          ),
          graph('SES reputation', [
            this.ses('Reputation.BounceRate'),
            this.ses('Reputation.ComplaintRate'),
          ]),
        ],
        [
          graph(
            'Queue depth',
            [messaging.intakeQueue, messaging.emailQueue].map((q) =>
              q.metricApproximateNumberOfMessagesVisible(),
            ),
          ),
          graph(
            'Oldest message (s)',
            [messaging.intakeQueue, messaging.emailQueue].map((q) =>
              q.metricApproximateAgeOfOldestMessage({ statistic: cw.Stats.MAXIMUM }),
            ),
          ),
          graph(
            'DLQ depth',
            dlqs.map((q) =>
              q.metricApproximateNumberOfMessagesVisible({ statistic: cw.Stats.MAXIMUM }),
            ),
          ),
        ],
        [
          graph(
            'Errors',
            fns.map((f) => f.metricErrors()),
          ),
          graph(
            'Duration p99',
            fns.map((f) => f.metricDuration({ statistic: 'p99' })),
          ),
          graph('Processor concurrency / throttles', [
            functions.processor.metric('ConcurrentExecutions', { statistic: cw.Stats.MAXIMUM }),
            functions.processor.metricThrottles(),
          ]),
        ],
      ],
    });
  }
}

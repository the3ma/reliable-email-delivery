import * as path from 'node:path';
import {
  type aws_dynamodb as dynamodb,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  type aws_kms as kms,
  aws_lambda as lambda,
  aws_lambda_event_sources as sources,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_scheduler as scheduler,
  aws_scheduler_targets as schedulerTargets,
  type aws_sqs as sqs,
  Duration,
  type RemovalPolicy,
  Stack,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { DeliveryConfig } from '../config';
import { BATCH_SIZE, MAX_BATCHING_WINDOW, METRICS_NAMESPACE, TIMEOUTS } from '../constants';
import { allowEventBridgeToUseKey, type Messaging } from './messaging';
import { encryptedQueue } from './queues';
import { FEEDBACK_DETAIL_TYPES, FEEDBACK_EVENT_TYPES, type Ses } from './ses';
import { SEGMENT_INDEX, type Storage } from './storage';
import type { Toggles } from './toggles';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HANDLERS = path.join(REPO_ROOT, 'packages', 'functions', 'src', 'handlers');

export type HandlerName = 'notifier-immediate' | 'notifier-digest' | 'processor' | 'feedback';

export interface FunctionsProps {
  readonly config: DeliveryConfig;
  readonly key: kms.IKey;
  readonly messaging: Messaging;
  readonly storage: Storage;
  readonly ses: Ses;
  readonly toggles: Toggles;
  readonly removalPolicy: RemovalPolicy;
}

/** The four handlers, their triggers, and one least-privilege role each. */
export class Functions extends Construct {
  readonly notifierImmediate: lambda.Function;
  readonly notifierDigest: lambda.Function;
  readonly processor: lambda.Function;
  readonly feedback: lambda.Function;
  readonly digestDlq: sqs.Queue;
  readonly scheduleGroup: scheduler.ScheduleGroup;
  readonly schedulerRole: iam.Role;
  /** Execution roles, for the cdk-nag suppressions that apply to every function. */
  readonly roles: iam.Role[] = [];

  private readonly props: FunctionsProps;

  constructor(scope: Construct, id: string, props: FunctionsProps) {
    super(scope, id);
    this.props = props;
    const { config, key, messaging, storage, ses, toggles } = props;
    const base = {
      POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
      LOG_LEVEL: config.logLevel,
    };

    // ---- notifier-immediate: intake queue -> render -> email queue (or pending-digest)
    this.notifierImmediate = this.fn(
      'NotifierImmediate',
      'notifier-immediate',
      TIMEOUTS.notifierImmediate,
      {
        ...base,
        TABLE_SUBSCRIPTIONS: storage.subscriptions.tableName,
        TABLE_PENDING_DIGEST: storage.pendingDigest.tableName,
        TABLE_DELIVERIES: storage.deliveries.tableName,
        EMAIL_QUEUE_URL: messaging.emailQueue.queueUrl,
        APP_BASE_URL: config.appBaseUrl,
      },
    );
    this.allowTable(this.notifierImmediate, storage.subscriptions, ['GetItem']);
    this.allowTable(this.notifierImmediate, storage.deliveries, ['GetItem']);
    this.allowTable(this.notifierImmediate, storage.pendingDigest, ['PutItem'], { write: true });
    messaging.emailQueue.grantSendMessages(this.notifierImmediate);
    this.notifierImmediate.addEventSource(
      new sources.SqsEventSource(messaging.intakeQueue, {
        batchSize: BATCH_SIZE,
        maxBatchingWindow: MAX_BATCHING_WINDOW,
        reportBatchItemFailures: true,
      }),
    );

    // ---- notifier-digest: one segment per scheduled invocation
    this.digestDlq = encryptedQueue(this, 'DigestDlq', {
      name: `${config.prefix}-digest-dlq`,
      key,
      removalPolicy: props.removalPolicy,
    });
    this.notifierDigest = this.fn(
      'NotifierDigest',
      'notifier-digest',
      TIMEOUTS.notifierDigest,
      {
        ...base,
        TABLE_SUBSCRIPTIONS: storage.subscriptions.tableName,
        TABLE_PENDING_DIGEST: storage.pendingDigest.tableName,
        TABLE_DELIVERIES: storage.deliveries.tableName,
        EMAIL_QUEUE_URL: messaging.emailQueue.queueUrl,
        APP_BASE_URL: config.appBaseUrl,
        SEGMENTS: String(config.segments),
      },
      // Lambda's own async retries would re-run a segment that may still be sending (ADR 0006).
      { retryAttempts: 0, maxEventAge: Duration.minutes(5), deadLetterQueue: this.digestDlq },
    );
    this.allowTable(this.notifierDigest, storage.subscriptions, ['Query'], {
      index: SEGMENT_INDEX,
      tableItself: false,
    });
    // Query per user on the table; consumed items are removed with BatchWriteItem delete requests.
    this.allowTable(this.notifierDigest, storage.pendingDigest, ['Query', 'BatchWriteItem'], {
      write: true,
    });
    this.allowTable(this.notifierDigest, storage.deliveries, ['GetItem']);
    messaging.emailQueue.grantSendMessages(this.notifierDigest);
    this.digestDlq.grantSendMessages(this.notifierDigest);

    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': Stack.of(this).account } },
      }),
      description: 'Invokes the digest notifier, one segment per schedule',
    });
    this.digestDlq.grantSendMessages(this.schedulerRole);
    this.scheduleGroup = this.digestSchedules(this.schedulerRole);

    // ---- processor: email queue -> claim -> SES -> mark
    this.processor = this.fn(
      'Processor',
      'processor',
      TIMEOUTS.processor,
      {
        ...base,
        TABLE_DELIVERIES: storage.deliveries.tableName,
        TABLE_DELIVERY_LOG: storage.deliveryLog.tableName,
        TABLE_SUPPRESSIONS: storage.suppressions.tableName,
        FROM_ADDRESS: config.fromAddress,
        SES_CONFIGURATION_SET: ses.configurationSetName,
        MAIL_TRANSPORT: 'ses',
        SSM_PREFIX: toggles.path,
        // Anything but the literal `false` disables sending in the handler (ADR 0005).
        SENDING_HARD_DISABLED: config.sendingHardDisabled ? 'true' : 'false',
      },
      config.reservedConcurrency !== undefined
        ? { reservedConcurrentExecutions: config.reservedConcurrency }
        : {},
      512,
    );
    this.allowTable(this.processor, storage.deliveries, ['GetItem', 'UpdateItem'], {
      write: true,
    });
    this.allowTable(this.processor, storage.deliveryLog, ['PutItem'], { write: true });
    this.allowTable(this.processor, storage.suppressions, ['GetItem']);
    this.processor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'SendAsTheConfiguredIdentityOnly',
        actions: ['ses:SendEmail'],
        resources: [ses.identityArn, ses.configurationSetArn],
        conditions: { StringEquals: { 'ses:FromAddress': config.fromAddress } },
      }),
    );
    this.processor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadAccountSuppressionList',
        // No resource-level permissions exist for this action.
        actions: ['ses:GetSuppressedDestination'],
        resources: ['*'],
      }),
    );
    this.processor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadToggles',
        actions: ['ssm:GetParametersByPath'],
        resources: toggles.pathArns,
      }),
    );
    this.processor.addEventSource(
      new sources.SqsEventSource(messaging.emailQueue, {
        batchSize: BATCH_SIZE,
        maxBatchingWindow: MAX_BATCHING_WINDOW,
        reportBatchItemFailures: true,
        // The only lever on the SES send rate: concurrent batches x sequential sends per batch.
        maxConcurrency: config.processorConcurrency,
      }),
    );

    // ---- feedback: SES events on the default bus -> suppressions + delivery log
    this.feedback = this.fn(
      'Feedback',
      'feedback',
      TIMEOUTS.feedback,
      {
        ...base,
        TABLE_SUPPRESSIONS: storage.suppressions.tableName,
        TABLE_DELIVERY_LOG: storage.deliveryLog.tableName,
      },
      { retryAttempts: 2, maxEventAge: Duration.hours(6), deadLetterQueue: messaging.eventsDlq },
    );
    this.allowTable(this.feedback, storage.suppressions, ['UpdateItem'], {
      write: true,
    });
    this.allowTable(this.feedback, storage.deliveryLog, ['PutItem'], { write: true });
    messaging.eventsDlq.grantSendMessages(this.feedback);
    this.feedbackRule();
  }

  private fn(
    id: string,
    name: HandlerName,
    timeout: Duration,
    environment: Record<string, string>,
    extra: Partial<lambda.FunctionOptions> = {},
    memorySize = 256,
  ): lambda.Function {
    const { config } = this.props;
    const functionName = `${config.prefix}-${name}`;
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: config.logRetentionDays,
      removalPolicy: this.props.removalPolicy,
    });
    // Own role instead of AWSLambdaBasicExecutionRole: log writes are scoped to this function's group.
    const role = new iam.Role(this, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Execution role for ${functionName}`,
    });
    logGroup.grantWrite(role);
    this.roles.push(role);

    const options: lambda.FunctionOptions = {
      functionName,
      description: `${name} (${config.stage})`,
      architecture: lambda.Architecture.ARM_64,
      memorySize,
      timeout,
      role,
      logGroup,
      tracing: lambda.Tracing.ACTIVE,
      environment: { ...environment, POWERTOOLS_SERVICE_NAME: functionName },
      ...extra,
    };
    if (config.skipBundling) {
      return new lambda.Function(this, id, {
        ...options,
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline(
          'exports.handler = async () => { throw new Error("placeholder code: synthesized with skipBundling"); };',
        ),
      });
    }
    return new nodejs.NodejsFunction(this, id, {
      ...options,
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(HANDLERS, `${name}.ts`),
      handler: 'handler',
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      bundling: {
        target: 'node22',
        format: nodejs.OutputFormat.CJS,
        minify: true,
        sourceMap: true,
        // AWS SDK v3 ships with the Node.js 22 runtime.
        externalModules: ['@aws-sdk/*'],
        loader: { '.txt': 'text', '.html': 'text' },
      },
    });
  }

  /** Explicit DynamoDB actions on one table (and optionally one index), plus the matching key use. */
  private allowTable(
    fn: lambda.Function,
    table: dynamodb.ITable,
    actions: string[],
    opts: { index?: string; write?: boolean; tableItself?: boolean } = {},
  ): void {
    const resources = [
      ...(opts.tableItself === false ? [] : [table.tableArn]),
      ...(opts.index ? [`${table.tableArn}/index/${opts.index}`] : []),
    ];
    fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: actions.map((a) => `dynamodb:${a}`), resources }),
    );
    if (opts.write) this.props.key.grantEncryptDecrypt(fn);
    else this.props.key.grantDecrypt(fn);
  }

  private digestSchedules(role: iam.IRole): scheduler.ScheduleGroup {
    const { config } = this.props;
    const group = new scheduler.ScheduleGroup(this, 'DigestSchedules', {
      scheduleGroupName: `${config.prefix}-digest`,
      removalPolicy: this.props.removalPolicy,
    });
    // One shared role for all schedules instead of one per schedule.
    for (let segment = 0; segment < config.segments; segment++) {
      // Stagger segments across the hour so the processor sees a steady stream, not one burst.
      const minute = Math.floor((segment * 60) / config.segments);
      new scheduler.Schedule(this, `Digest${segment}`, {
        scheduleName: `${config.prefix}-digest-${String(segment).padStart(2, '0')}`,
        scheduleGroup: group,
        description: `Digest segment ${segment}; the handler picks users whose local time is in the digest window`,
        schedule: scheduler.ScheduleExpression.expression(
          `cron(${minute} ${config.digestWindow} * * ? *)`,
        ),
        timeWindow: scheduler.TimeWindow.off(),
        target: new schedulerTargets.LambdaInvoke(this.notifierDigest, {
          role,
          input: scheduler.ScheduleTargetInput.fromObject({ segment }),
          // A retry could start the segment again while the first run is still sending (ADR 0006).
          retryAttempts: 0,
          maxEventAge: Duration.minutes(5),
          deadLetterQueue: this.digestDlq,
        }),
      });
    }
    return group;
  }

  private feedbackRule(): void {
    const { config, key, messaging, ses } = this.props;
    const ruleName = `${config.prefix}-ses-feedback`;
    const rule = new events.Rule(this, 'SesFeedback', {
      ruleName,
      description: 'SES sending events of this configuration set -> feedback',
      eventPattern: {
        source: ['aws.ses'],
        detailType: FEEDBACK_DETAIL_TYPES,
        detail: {
          eventType: FEEDBACK_EVENT_TYPES,
          // Other configuration sets in the account are not ours to act on.
          mail: { tags: { 'ses:configuration-set': [ses.configurationSetName] } },
        },
      },
    });
    rule.addTarget(
      new targets.LambdaFunction(this.feedback, {
        deadLetterQueue: messaging.eventsDlq,
        retryAttempts: 185,
        maxEventAge: Duration.hours(24),
      }),
    );
    allowEventBridgeToUseKey(
      key,
      'AllowFeedbackRule',
      Stack.of(this).formatArn({ service: 'events', resource: 'rule', resourceName: ruleName }),
    );
  }
}

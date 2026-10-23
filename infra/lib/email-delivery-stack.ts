import { aws_kms as kms, Duration, RemovalPolicy, Stack, type StackProps, Tags } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { DeliveryConfig } from './config';
import { Functions } from './constructs/functions';
import { Messaging } from './constructs/messaging';
import { Monitoring } from './constructs/monitoring';
import { Redrive } from './constructs/redrive';
import { Ses } from './constructs/ses';
import { Storage } from './constructs/storage';
import { Toggles } from './constructs/toggles';
import { applyNagSuppressions } from './nag';

export interface EmailDeliveryStackProps extends StackProps {
  readonly config: DeliveryConfig;
}

export class EmailDeliveryStack extends Stack {
  readonly config: DeliveryConfig;
  readonly key: kms.Key;
  readonly messaging: Messaging;
  readonly storage: Storage;
  readonly ses: Ses;
  readonly toggles: Toggles;
  readonly functions: Functions;
  readonly monitoring: Monitoring;
  readonly redrive: Redrive;

  constructor(scope: Construct, id: string, props: EmailDeliveryStackProps) {
    super(scope, id, props);
    const { config } = props;
    this.config = config;
    const prod = config.stage === 'prod';
    const removalPolicy = prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    Tags.of(this).add('app', 'email-delivery');
    Tags.of(this).add('stage', config.stage);

    // One customer-managed key for queues, tables and the alarm topic: one place to audit and revoke.
    this.key = new kms.Key(this, 'Key', {
      alias: `alias/${config.prefix}-email`,
      description: `Encrypts e-mail delivery queues, tables and alarms (${config.stage})`,
      enableKeyRotation: true,
      pendingWindow: Duration.days(prod ? 30 : 7),
      removalPolicy,
    });

    this.messaging = new Messaging(this, 'Messaging', {
      prefix: config.prefix,
      key: this.key,
      removalPolicy,
    });
    this.storage = new Storage(this, 'Storage', {
      prefix: config.prefix,
      key: this.key,
      protect: prod,
    });
    this.ses = new Ses(this, 'Ses', {
      prefix: config.prefix,
      sesIdentity: config.sesIdentity,
      ...(config.sendingDomain ? { sendingDomain: config.sendingDomain } : {}),
    });
    this.toggles = new Toggles(this, 'Toggles', {
      prefix: config.prefix,
      sendEmails: config.sendEmails,
      recordDeliveries: config.recordDeliveries,
    });
    this.functions = new Functions(this, 'Functions', {
      config,
      key: this.key,
      messaging: this.messaging,
      storage: this.storage,
      ses: this.ses,
      toggles: this.toggles,
      removalPolicy,
    });
    this.monitoring = new Monitoring(this, 'Monitoring', {
      prefix: config.prefix,
      key: this.key,
      messaging: this.messaging,
      functions: this.functions,
      ...(config.alarmEmail ? { alarmEmail: config.alarmEmail } : {}),
    });
    this.redrive = new Redrive(this, 'Redrive', {
      prefix: config.prefix,
      key: this.key,
      pairs: [
        { name: 'Email', dlq: this.messaging.emailDlq, source: this.messaging.emailQueue },
        { name: 'Intake', dlq: this.messaging.intakeDlq, source: this.messaging.intakeQueue },
      ],
      inspectOnly: [
        { name: 'Events', dlq: this.messaging.eventsDlq },
        { name: 'Digest', dlq: this.functions.digestDlq },
      ],
      ...(config.operatorPrincipalArn ? { operatorPrincipalArn: config.operatorPrincipalArn } : {}),
    });

    applyNagSuppressions(this);
  }
}

import { aws_events as events, aws_ses as ses, CfnOutput, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface SesProps {
  readonly prefix: string;
  /** Domain to own as an SES identity; when unset the identity is assumed to exist already. */
  readonly sendingDomain?: string;
  readonly sesIdentity: string;
}

/** The SES event types published to EventBridge (rendering failures and delays: dashboards/ad hoc rules). */
export const SES_EVENTS = [
  ses.EmailSendingEvent.BOUNCE,
  ses.EmailSendingEvent.COMPLAINT,
  ses.EmailSendingEvent.DELIVERY,
  ses.EmailSendingEvent.REJECT,
  ses.EmailSendingEvent.RENDERING_FAILURE,
  ses.EmailSendingEvent.DELIVERY_DELAY,
];

/** The events the feedback function acts on: EventBridge `detail-type` and the SES `eventType`. */
export const FEEDBACK_DETAIL_TYPES = [
  'Email Bounced',
  'Email Complaint Received',
  'Email Delivered',
  'Email Rejected',
];
export const FEEDBACK_EVENT_TYPES = ['Bounce', 'Complaint', 'Delivery', 'Reject'];

export class Ses extends Construct {
  readonly configurationSet: ses.ConfigurationSet;
  readonly configurationSetName: string;
  readonly configurationSetArn: string;
  readonly identityArn: string;

  constructor(scope: Construct, id: string, props: SesProps) {
    super(scope, id);
    const stack = Stack.of(this);

    this.configurationSetName = `${props.prefix}-email`;
    this.configurationSet = new ses.ConfigurationSet(this, 'ConfigurationSet', {
      configurationSetName: this.configurationSetName,
      reputationMetrics: true,
      sendingEnabled: true,
      // Suppress at the configuration-set level as well, independent of the account-level setting.
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
      // Notification bodies carry user data; never hand them to a receiver over plain SMTP.
      tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
    });

    // SES only publishes to the default bus.
    const defaultBus = events.EventBus.fromEventBusName(this, 'DefaultBus', 'default');
    this.configurationSet.addEventDestination('EventBridge', {
      configurationSetEventDestinationName: 'eventbridge',
      destination: ses.EventDestination.eventBus(defaultBus),
      events: SES_EVENTS,
    });

    // Built from names so IAM statements do not depend on the resources (no cycles, works for both cases).
    this.configurationSetArn = stack.formatArn({
      service: 'ses',
      resource: 'configuration-set',
      resourceName: this.configurationSetName,
    });
    this.identityArn = stack.formatArn({
      service: 'ses',
      resource: 'identity',
      resourceName: props.sesIdentity,
    });

    if (props.sendingDomain) {
      const identity = new ses.EmailIdentity(this, 'DomainIdentity', {
        identity: ses.Identity.domain(props.sendingDomain),
        configurationSet: this.configurationSet,
        dkimSigning: true,
        dkimIdentity: ses.DkimIdentity.easyDkim(ses.EasyDkimSigningKeyLength.RSA_2048_BIT),
        mailFromDomain: `bounce.${props.sendingDomain}`,
      });
      identity.dkimRecords.forEach((record, i) => {
        new CfnOutput(Stack.of(this), `DkimRecord${i + 1}`, {
          description: `CNAME to publish for Easy DKIM (${i + 1}/3)`,
          value: `${record.name} CNAME ${record.value}`,
        });
      });
      new CfnOutput(Stack.of(this), 'MailFromRecords', {
        description: 'Records to publish for the custom MAIL FROM domain',
        value: `bounce.${props.sendingDomain} MX 10 feedback-smtp.${stack.region}.amazonses.com; bounce.${props.sendingDomain} TXT "v=spf1 include:amazonses.com ~all"`,
      });
    }
  }
}

import { Match } from 'aws-cdk-lib/assertions';
import { ofType, PROD, synth } from './helpers';

describe('SES', () => {
  const dev = synth();
  const prod = synth(PROD);

  it('configuration set: reputation metrics, sending on, suppression of bounces + complaints, TLS required', () => {
    dev.template.hasResourceProperties('AWS::SES::ConfigurationSet', {
      Name: 'mail-dev-email',
      ReputationOptions: { ReputationMetricsEnabled: true },
      SendingOptions: { SendingEnabled: true },
      SuppressionOptions: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
      DeliveryOptions: { TlsPolicy: 'REQUIRE' },
    });
  });

  it('publishes exactly the feedback event types to the default EventBridge bus', () => {
    dev.template.hasResourceProperties('AWS::SES::ConfigurationSetEventDestination', {
      EventDestination: {
        Enabled: true,
        MatchingEventTypes: [
          'bounce',
          'complaint',
          'delivery',
          'reject',
          'renderingFailure',
          'deliveryDelay',
        ],
        EventBridgeDestination: { EventBusArn: Match.anyValue() },
      },
    });
    const dest = ofType(dev.resources, 'AWS::SES::ConfigurationSetEventDestination')[0]?.[1];
    expect(JSON.stringify(dest)).toContain(':event-bus/default');
  });

  it('without sendingDomain an existing identity is used and none is created', () => {
    expect(ofType(dev.resources, 'AWS::SES::EmailIdentity')).toHaveLength(0);
  });

  it('with sendingDomain: domain identity with Easy DKIM and MAIL FROM bounce.<domain>', () => {
    prod.template.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'example.test',
      DkimAttributes: { SigningEnabled: true },
      DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
      MailFromAttributes: { MailFromDomain: 'bounce.example.test' },
      ConfigurationSetAttributes: { ConfigurationSetName: Match.anyValue() },
    });
  });

  it('feedback rule matches SES events of this configuration set only, on the default bus', () => {
    dev.template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'mail-dev-ses-feedback',
      EventBusName: Match.absent(),
      EventPattern: {
        source: ['aws.ses'],
        'detail-type': [
          'Email Bounced',
          'Email Complaint Received',
          'Email Delivered',
          'Email Rejected',
        ],
        detail: {
          eventType: ['Bounce', 'Complaint', 'Delivery', 'Reject'],
          mail: { tags: { 'ses:configuration-set': ['mail-dev-email'] } },
        },
      },
    });
  });
});

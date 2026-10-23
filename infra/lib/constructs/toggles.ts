import { aws_ssm as ssm, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { Toggle } from '../config';

export interface TogglesProps {
  readonly prefix: string;
  readonly sendEmails: Toggle;
  readonly recordDeliveries: Toggle;
}

/**
 * Operational kill switches read by the processor with GetParametersByPath (CONTRACT section 7).
 *
 * CloudFormation writes the value on create and whenever a property of the resource changes; it does
 * not revert a value changed by hand. So prod is created `disabled` (nothing can send before the SES
 * identity is verified and out of the sandbox) and enabling is a deliberate operator step - keep the
 * resource properties stable, or set `-c sendEmails=enabled` once sending is live, so that a later
 * deploy cannot silently flip it back.
 */
export class Toggles extends Construct {
  /** `/<prefix>/email/` - the value of SSM_PREFIX. */
  readonly path: string;
  /** ARNs covering GetParametersByPath on the path (the path itself and the parameters below it). */
  readonly pathArns: string[];

  constructor(scope: Construct, id: string, props: TogglesProps) {
    super(scope, id);
    this.path = `/${props.prefix}/email/`;

    new ssm.StringParameter(this, 'SendEmails', {
      parameterName: `${this.path}send-emails`,
      stringValue: props.sendEmails,
      allowedPattern: '^(enabled|disabled)$',
      description:
        'enabled | disabled - operational kill switch for all e-mail sending (cached 5 min)',
    });
    new ssm.StringParameter(this, 'RecordDeliveries', {
      parameterName: `${this.path}record-deliveries`,
      stringValue: props.recordDeliveries,
      allowedPattern: '^(enabled|disabled)$',
      description: 'enabled | disabled - write per-event items to the delivery log',
    });

    const stack = Stack.of(this);
    const base = `${props.prefix}/email`;
    this.pathArns = [
      stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: base }),
      stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `${base}/*` }),
    ];
  }
}

import { type App, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadConfig } from './config';
import { EmailDeliveryStack } from './email-delivery-stack';

/** Builds the stack from the app's context. Shared by bin/app.ts and the tests. */
export function buildApp(app: App, opts: { nag?: boolean } = {}): EmailDeliveryStack {
  const config = loadConfig(app.node);
  const stack = new EmailDeliveryStack(app, `EmailDelivery-${config.stage}`, {
    config,
    description: `Reliable e-mail delivery: intake, digest, processor, SES feedback (${config.stage})`,
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
    terminationProtection: config.stage === 'prod',
  });
  if (opts.nag ?? true) Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  return stack;
}

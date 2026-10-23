import { SESv2Client } from '@aws-sdk/client-sesv2';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  DynamoDeliveriesStore,
  DynamoDeliveryLog,
  DynamoPendingDigest,
  DynamoSubscriptions,
  DynamoSuppressions,
  SesAccountSuppressionList,
  SesTransport,
  SmtpTransport,
  SsmToggleSource,
  ToggleCache,
  describeError,
  documentClient,
  sesClient,
  ssmClient,
} from '@mail/core';
import type { MailTransport } from '@mail/core';
import type { Tracer } from '@aws-lambda-powertools/tracer';
import { intEnv, optionalEnv, requireEnv } from './env.js';
import type { SafeLog } from './observability.js';

/** Real adapters, built once per container from the contract's environment (section 8). */
export function awsAdapters(tracer: Tracer) {
  const ddb = tracer.captureAWSv3Client(documentClient());
  return {
    ddb,
    sqs: () => tracer.captureAWSv3Client(new SQSClient({})),
    deliveries: () => new DynamoDeliveriesStore(ddb, requireEnv('TABLE_DELIVERIES')),
    deliveryLog: () => new DynamoDeliveryLog(ddb, requireEnv('TABLE_DELIVERY_LOG')),
    suppressions: () => new DynamoSuppressions(ddb, requireEnv('TABLE_SUPPRESSIONS')),
    subscriptions: () => new DynamoSubscriptions(ddb, requireEnv('TABLE_SUBSCRIPTIONS')),
    pendingDigest: () => new DynamoPendingDigest(ddb, requireEnv('TABLE_PENDING_DIGEST')),
  };
}

export function mailTransport(tracer: Tracer): MailTransport {
  const kind = optionalEnv('MAIL_TRANSPORT') ?? 'ses';
  if (kind === 'smtp') {
    return new SmtpTransport({
      host: optionalEnv('SMTP_HOST') ?? 'localhost',
      port: intEnv('SMTP_PORT', 1025),
    });
  }
  if (kind !== 'ses') throw new Error('MAIL_TRANSPORT must be "ses" or "smtp"');
  return new SesTransport(
    tracer.captureAWSv3Client(sesClient()),
    optionalEnv('SES_CONFIGURATION_SET'),
  );
}

/** The SES account suppression list is only meaningful when sending through SES. */
export function accountSuppressionList(tracer: Tracer): SesAccountSuppressionList | undefined {
  if ((optionalEnv('MAIL_TRANSPORT') ?? 'ses') !== 'ses') return undefined;
  if (optionalEnv('CHECK_SES_SUPPRESSION_LIST') === 'false') return undefined;
  return new SesAccountSuppressionList(tracer.captureAWSv3Client(new SESv2Client({})));
}

export function toggleCache(tracer: Tracer, log: SafeLog): ToggleCache {
  const source = new SsmToggleSource(
    tracer.captureAWSv3Client(ssmClient()),
    requireEnv('SSM_PREFIX'),
  );
  return new ToggleCache(source, {
    onRefreshError: (error, servingStale) => {
      log.warn(
        servingStale
          ? 'toggle refresh failed; serving stale values'
          : 'toggles unavailable; failing safe (disabled)',
        {
          error: describeError(error),
        },
      );
    },
  });
}

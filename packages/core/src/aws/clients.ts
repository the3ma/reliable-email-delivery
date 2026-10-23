import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// The SDK reads AWS_ENDPOINT_URL (LocalStack) and AWS_REGION from the environment by itself.

export function documentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({ requestHandler: { connectionTimeout: 2_000, requestTimeout: 5_000 } }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
}

/**
 * SendEmail is not idempotent, so the SDK must not retry it behind our back: a retried timeout
 * can deliver twice. Retries happen only through the claim state machine (RELEASED -> SQS).
 */
export function sesClient(): SESv2Client {
  return new SESv2Client({
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
  });
}

export function ssmClient(): SSMClient {
  return new SSMClient({ requestHandler: { connectionTimeout: 2_000, requestTimeout: 3_000 } });
}

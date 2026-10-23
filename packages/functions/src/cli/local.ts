import { randomUUID } from 'node:crypto';
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { scrubAddresses } from '@mail/core';
import type { Context } from 'aws-lambda';

/** Contract section 8 "Local" column; anything already set in the environment wins. */
const LOCAL_DEFAULTS: Readonly<Record<string, string>> = {
  AWS_REGION: 'us-east-1',
  TABLE_SUBSCRIPTIONS: 'subscriptions',
  TABLE_PENDING_DIGEST: 'pending-digest',
  TABLE_DELIVERIES: 'deliveries',
  TABLE_DELIVERY_LOG: 'delivery-log',
  TABLE_SUPPRESSIONS: 'suppressions',
  FROM_ADDRESS: 'notifications@example.test',
  MAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SSM_PREFIX: '/local/email/',
  APP_BASE_URL: 'http://localhost:8080',
  SEGMENTS: '16',
  POWERTOOLS_METRICS_NAMESPACE: 'EmailDelivery',
  POWERTOOLS_TRACE_ENABLED: 'false',
  // SENDING_HARD_DISABLED is deliberately not defaulted: unset means "disabled", even locally.
};

export function applyLocalDefaults(serviceName: string): void {
  for (const [name, value] of Object.entries(LOCAL_DEFAULTS)) {
    if (process.env[name] === undefined || process.env[name] === '') process.env[name] = value;
  }
  process.env.POWERTOOLS_SERVICE_NAME ??= serviceName;
}

/** A Lambda-shaped context with a real deadline, so the handlers' remaining-time guards apply. */
export function localContext(functionName: string, timeoutMs: number): Context {
  const deadline = Date.now() + timeoutMs;
  const context: Omit<Context, 'done' | 'fail' | 'succeed'> = {
    callbackWaitsForEmptyEventLoop: false,
    functionName,
    functionVersion: '$LATEST',
    invokedFunctionArn: `arn:aws:lambda:${process.env.AWS_REGION ?? 'us-east-1'}:000000000000:function:${functionName}`,
    memoryLimitInMB: '512',
    awsRequestId: randomUUID(),
    logGroupName: `/local/${functionName}`,
    logStreamName: 'local',
    getRemainingTimeInMillis: () => Math.max(0, deadline - Date.now()),
  };
  // The deprecated callback members are never used by async handlers.
  return context as Context;
}

export async function resolveQueueUrl(
  sqs: SQSClient,
  envName: string,
  queueName: string,
): Promise<string> {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  const result = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (!result.QueueUrl) throw new Error(`queue ${queueName} not found`);
  return result.QueueUrl;
}

export type ArgValue = string | boolean;

/** Minimal `--name value` / `--flag` parser; unknown flags are rejected so typos fail loudly. */
export function parseArgs(
  argv: readonly string[],
  known: Readonly<Record<string, 'string' | 'boolean'>>,
): Record<string, ArgValue> {
  const args: Record<string, ArgValue> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? '';
    if (!raw.startsWith('--')) throw new Error(`unexpected argument "${raw}"`);
    const [name = '', inline] = raw.slice(2).split('=', 2);
    const kind = known[name];
    if (!kind) throw new Error(`unknown option --${name}`);
    if (kind === 'boolean') {
      args[name] = true;
      continue;
    }
    const value = inline ?? argv[i + 1];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      throw new Error(`--${name} needs a value`);
    }
    if (inline === undefined) i += 1;
    args[name] = value;
  }
  return args;
}

export function intArg(args: Record<string, ArgValue>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`--${name} must be a non-negative integer`);
  return parsed;
}

export function stringArg(args: Record<string, ArgValue>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

export async function main(run: () => Promise<number | undefined>): Promise<void> {
  try {
    process.exitCode = (await run()) ?? 0;
  } catch (error) {
    console.error(scrubAddresses(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

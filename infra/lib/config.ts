import { aws_logs as logs } from 'aws-cdk-lib';
import type { Node } from 'constructs';

export type Stage = 'dev' | 'prod';
export type Toggle = 'enabled' | 'disabled';

export interface DeliveryConfig {
  readonly stage: Stage;
  /** Prefix for physical names and the SSM path `/<prefix>/email/`. */
  readonly prefix: string;
  /** When set, the stack owns an SES domain identity (Easy DKIM + custom MAIL FROM). */
  readonly sendingDomain?: string;
  readonly fromAddress: string;
  /** SES identity the processor may send as: the domain when owned, else an existing identity. */
  readonly sesIdentity: string;
  readonly alarmEmail?: string;
  /** Cron hours field (UTC) in which the digest segments fire, e.g. `*` or `4-10`. */
  readonly digestWindow: string;
  readonly segments: number;
  /** SQS event source maxConcurrency for the processor - the effective cap on the SES send rate. */
  readonly processorConcurrency: number;
  readonly reservedConcurrency?: number;
  readonly logRetentionDays: logs.RetentionDays;
  readonly logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  readonly appBaseUrl: string;
  readonly sendingHardDisabled: boolean;
  /** Initial value of the `send-emails` parameter (CloudFormation only sets it on create or on a property change). */
  readonly sendEmails: Toggle;
  readonly recordDeliveries: Toggle;
  /** Principal allowed to assume the DLQ redrive role; no role is created when unset. */
  readonly operatorPrincipalArn?: string;
  readonly skipBundling: boolean;
}

type Raw = string | number | boolean | undefined;

const EMAIL = /^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const PREFIX = /^[a-z][a-z0-9-]{1,30}$/;
const HOURS = /^(\*|([01]?\d|2[0-3])(-([01]?\d|2[0-3]))?(,([01]?\d|2[0-3])(-([01]?\d|2[0-3]))?)*)$/;
const ARN = /^arn:aws[a-z-]*:iam::\d{12}:(root|role\/[\w+=,.@/-]+|user\/[\w+=,.@/-]+)$/;
const RETENTION = new Map<number, logs.RetentionDays>(
  Object.values(logs.RetentionDays)
    .filter((v): v is logs.RetentionDays => typeof v === 'number')
    .map((v): [number, logs.RetentionDays] => [v, v]),
);

export class ConfigError extends Error {}

function str(node: Node, key: string): string | undefined {
  const value = node.tryGetContext(key) as Raw;
  if (value === undefined || value === '') return undefined;
  return String(value).trim();
}

function int(
  node: Node,
  key: string,
  fallback: number | undefined,
  min: number,
  max: number,
): number | undefined {
  const raw = str(node, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`context ${key} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return value;
}

function bool(node: Node, key: string, fallback: boolean): boolean {
  const raw = str(node, key);
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(`context ${key} must be true or false, got "${raw}"`);
}

function oneOf<T extends string>(node: Node, key: string, allowed: readonly T[], fallback: T): T {
  const raw = str(node, key) ?? fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(`context ${key} must be one of ${allowed.join('|')}, got "${raw}"`);
  }
  return raw as T;
}

function match(key: string, value: string | undefined, pattern: RegExp): string | undefined {
  if (value !== undefined && !pattern.test(value)) {
    throw new ConfigError(`context ${key} is not valid: "${value}"`);
  }
  return value;
}

/** Reads and validates the CDK context. Throws ConfigError so a bad flag fails synth, not deploy. */
export function loadConfig(node: Node): DeliveryConfig {
  const stage = oneOf<Stage>(node, 'stage', ['dev', 'prod'], 'dev');
  const prod = stage === 'prod';
  const prefix = match('prefix', str(node, 'prefix') ?? `mail-${stage}`, PREFIX) ?? '';
  const sendingDomain = match('sendingDomain', str(node, 'sendingDomain')?.toLowerCase(), DOMAIN);
  const fromAddress =
    match(
      'fromAddress',
      str(node, 'fromAddress') ?? `notifications@${sendingDomain ?? 'example.test'}`,
      EMAIL,
    ) ?? '';
  if (sendingDomain && !fromAddress.toLowerCase().endsWith(`@${sendingDomain}`)) {
    throw new ConfigError(
      `fromAddress ${fromAddress} must belong to sendingDomain ${sendingDomain}`,
    );
  }
  const alarmEmail = match('alarmEmail', str(node, 'alarmEmail'), EMAIL);
  if (prod && !alarmEmail) {
    throw new ConfigError(
      'context alarmEmail is required for stage=prod (alarms nobody receives are not alarms)',
    );
  }

  const processorConcurrency = int(node, 'processorConcurrency', 2, 2, 1000) ?? 2;
  const reservedConcurrency = int(node, 'reservedConcurrency', undefined, 1, 1000);
  if (reservedConcurrency !== undefined && reservedConcurrency < processorConcurrency) {
    // Below maxConcurrency, the event source would be throttled and messages would bounce to the DLQ.
    throw new ConfigError('reservedConcurrency must be >= processorConcurrency');
  }

  const retentionDays = int(node, 'logRetentionDays', prod ? 90 : 14, 1, 3653) ?? 14;
  const logRetentionDays = RETENTION.get(retentionDays);
  if (logRetentionDays === undefined) {
    throw new ConfigError(
      `context logRetentionDays ${retentionDays} is not a CloudWatch Logs retention value`,
    );
  }

  return {
    stage,
    prefix,
    ...(sendingDomain ? { sendingDomain } : {}),
    fromAddress,
    sesIdentity: sendingDomain ?? str(node, 'sesIdentity') ?? fromAddress,
    ...(alarmEmail ? { alarmEmail } : {}),
    digestWindow: match('digestWindow', str(node, 'digestWindow') ?? '*', HOURS) ?? '*',
    // Up to 60: one distinct minute per segment inside the hour.
    segments: int(node, 'segments', 16, 1, 60) ?? 16,
    processorConcurrency,
    ...(reservedConcurrency !== undefined ? { reservedConcurrency } : {}),
    logRetentionDays,
    logLevel: oneOf(node, 'logLevel', ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const, 'INFO'),
    appBaseUrl:
      match(
        'appBaseUrl',
        str(node, 'appBaseUrl') ?? 'https://app.example.test',
        /^https?:\/\/\S+$/,
      ) ?? '',
    sendingHardDisabled: bool(node, 'sendingHardDisabled', false),
    sendEmails: oneOf<Toggle>(
      node,
      'sendEmails',
      ['enabled', 'disabled'],
      prod ? 'disabled' : 'enabled',
    ),
    recordDeliveries: oneOf<Toggle>(node, 'recordDeliveries', ['enabled', 'disabled'], 'enabled'),
    ...(str(node, 'operatorPrincipalArn')
      ? {
          operatorPrincipalArn: match(
            'operatorPrincipalArn',
            str(node, 'operatorPrincipalArn'),
            ARN,
          ),
        }
      : {}),
    skipBundling: bool(node, 'skipBundling', false),
  };
}

import { DEFAULT_DIGEST_WINDOW, parseDigestWindow } from '@mail/core';
import type { DigestWindow } from '@mail/core';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface ConsoleConfig {
  port: number;
  host: string;
  awsEndpointUrl: string;
  mailpitUrl: string;
  webOrigin: string;
  appBaseUrl: string;
  tables: {
    subscriptions: string;
    pendingDigest: string;
    deliveries: string;
    deliveryLog: string;
    suppressions: string;
  };
  queues: { intake: string; intakeDlq: string; email: string; emailDlq: string };
  eventBusName: string;
  ssmPrefix: string;
  segments: number;
  digestWindow: DigestWindow;
  seed: { users: number; suppressEvery: number };
  /** The processor workers' TOGGLE_CACHE_TTL_SECONDS: how long a kill-switch flip takes to apply. */
  workerToggleTtlSeconds: number;
  /** How long background scenarios wait for the workers before giving up. */
  scenarioWaitMs: number;
}

function int(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer in ${String(min)}..${String(max)}`);
  }
  return value;
}

function str(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
}

/**
 * Local only: without AWS_ENDPOINT_URL the SDK would talk to a real AWS account, so the console
 * refuses to start; an amazonaws.com endpoint is refused for the same reason.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConsoleConfig {
  const awsEndpointUrl = env.AWS_ENDPOINT_URL;
  if (awsEndpointUrl === undefined || awsEndpointUrl === '') {
    throw new ConfigError(
      'AWS_ENDPOINT_URL is not set: the Delivery Console only runs against a local stack (LocalStack).',
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(awsEndpointUrl);
  } catch {
    throw new ConfigError('AWS_ENDPOINT_URL is not a valid URL');
  }
  if (
    endpoint.hostname.endsWith('amazonaws.com') ||
    endpoint.hostname.endsWith('amazonaws.com.cn')
  ) {
    throw new ConfigError('AWS_ENDPOINT_URL points at AWS; the Delivery Console is local only.');
  }
  const ssmPrefix = str(env, 'SSM_PREFIX', '/local/email/');
  return {
    port: int(env, 'PORT', 3001, 1, 65_535),
    host: str(env, 'HOST', '0.0.0.0'),
    awsEndpointUrl,
    mailpitUrl: str(env, 'MAILPIT_URL', 'http://localhost:8025').replace(/\/+$/, ''),
    webOrigin: str(env, 'WEB_ORIGIN', 'http://localhost:8080'),
    appBaseUrl: str(env, 'APP_BASE_URL', 'http://localhost:8080'),
    tables: {
      subscriptions: str(env, 'TABLE_SUBSCRIPTIONS', 'subscriptions'),
      pendingDigest: str(env, 'TABLE_PENDING_DIGEST', 'pending-digest'),
      deliveries: str(env, 'TABLE_DELIVERIES', 'deliveries'),
      deliveryLog: str(env, 'TABLE_DELIVERY_LOG', 'delivery-log'),
      suppressions: str(env, 'TABLE_SUPPRESSIONS', 'suppressions'),
    },
    queues: {
      intake: str(env, 'INTAKE_QUEUE_NAME', 'intake'),
      intakeDlq: str(env, 'INTAKE_DLQ_NAME', 'intake-dlq'),
      email: str(env, 'EMAIL_QUEUE_NAME', 'email'),
      emailDlq: str(env, 'EMAIL_DLQ_NAME', 'email-dlq'),
    },
    eventBusName: str(env, 'EVENT_BUS_NAME', 'app-events'),
    ssmPrefix: ssmPrefix.endsWith('/') ? ssmPrefix : `${ssmPrefix}/`,
    segments: int(env, 'SEGMENTS', 16, 1, 256),
    digestWindow:
      env.DIGEST_WINDOW_START_HOUR || env.DIGEST_WINDOW_END_HOUR
        ? parseDigestWindow(env.DIGEST_WINDOW_START_HOUR, env.DIGEST_WINDOW_END_HOUR)
        : DEFAULT_DIGEST_WINDOW,
    seed: {
      users: int(env, 'SEED_USERS', 40, 1, 1000),
      suppressEvery: int(env, 'SEED_SUPPRESS_EVERY', 10, 0, 1000),
    },
    workerToggleTtlSeconds: int(env, 'TOGGLE_CACHE_TTL_SECONDS', 300, 0, 3600),
    scenarioWaitMs: int(env, 'SCENARIO_WAIT_SECONDS', 120, 1, 3600) * 1000,
  };
}

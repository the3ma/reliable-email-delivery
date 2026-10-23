import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics } from '@aws-lambda-powertools/metrics';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { vi } from 'vitest';
import { PowertoolsTelemetry, SafeLog } from '../src/lib/observability.js';
import type { MetricName, Telemetry } from '../src/lib/observability.js';

export class CountingTelemetry implements Telemetry {
  readonly counts = new Map<MetricName, number>();
  flushes = 0;

  count(name: MetricName, value = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + value);
  }

  flush(): void {
    this.flushes += 1;
  }

  get(name: MetricName): number {
    return this.counts.get(name) ?? 0;
  }
}

/**
 * Captures everything Powertools writes (it uses its own Console bound to process.stdout/stderr),
 * so tests can assert on the real serialised log lines.
 */
export function captureOutput(): { lines: () => string[]; text: () => string } {
  const chunks: string[] = [];
  const grab = (chunk: unknown): boolean => {
    chunks.push(
      typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'),
    );
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(grab);
  vi.spyOn(process.stderr, 'write').mockImplementation(grab);
  return {
    text: () => chunks.join(''),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0),
  };
}

export function testLog(): SafeLog {
  return new SafeLog(new Logger({ serviceName: 'test', logLevel: 'DEBUG' }));
}

export function powertoolsTelemetry(log: SafeLog): {
  telemetry: PowertoolsTelemetry;
  metrics: Metrics;
} {
  const metrics = new Metrics({ serviceName: 'test', namespace: 'EmailDelivery' });
  return { telemetry: new PowertoolsTelemetry(metrics, log), metrics };
}

let counter = 0;

export function sqsRecord(body: unknown, messageId = `m-${(counter += 1)}`): SQSRecord {
  return {
    messageId,
    receiptHandle: `rh-${messageId}`,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '0',
      SenderId: 'test',
      ApproximateFirstReceiveTimestamp: '0',
    },
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:test',
    awsRegion: 'us-east-1',
  };
}

export function sqsEvent(...bodies: unknown[]): SQSEvent {
  return { Records: bodies.map((body) => sqsRecord(body)) };
}

/** Remaining time is either fixed or driven by a function (to simulate the clock running down). */
export function context(remaining: number | (() => number) = 60_000, awsRequestId = 'req-1') {
  return {
    awsRequestId,
    getRemainingTimeInMillis: typeof remaining === 'number' ? () => remaining : remaining,
  };
}

export const FIXED_NOW = new Date('2026-10-23T07:30:00Z');

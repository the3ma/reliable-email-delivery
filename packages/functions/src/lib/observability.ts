import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { describeError, redact, scrubAddresses } from '@mail/core';

export const METRIC_NAMES = [
  'MessagesReceived',
  'EmailsSent',
  'EmailsSkipped',
  'InvalidMessages',
  'DuplicatesSuppressed',
  'ClaimContention',
  'TransientFailures',
  'PermanentFailures',
  'AmbiguousDeliveries',
  'MarkFailures',
  'Suppressed',
  'NotificationsQueued',
  'DigestUsers',
  'FeedbackEvents',
  'Bounces',
  'Complaints',
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

/** Counters only, dimension `service` only (contract section 9). */
export interface Telemetry {
  count(name: MetricName, value?: number): void;
  /** Must never throw: a metrics failure cannot change a delivery outcome. */
  flush(): void;
}

export type LogExtra = Record<string, unknown>;

/**
 * The only logger handlers use. Every message and every extra field goes through redaction, so
 * an address that slips into an error message or a payload is masked before it reaches a sink.
 */
export class SafeLog {
  constructor(readonly logger: Logger) {}

  debug(message: string, extra: LogExtra = {}): void {
    this.logger.debug(scrubAddresses(message), redact(extra) as LogExtra);
  }

  info(message: string, extra: LogExtra = {}): void {
    this.logger.info(scrubAddresses(message), redact(extra) as LogExtra);
  }

  warn(message: string, extra: LogExtra = {}): void {
    this.logger.warn(scrubAddresses(message), redact(extra) as LogExtra);
  }

  /** `error` may be undefined for alarm-worthy conditions that are not exceptions. */
  error(message: string, error?: unknown, extra: LogExtra = {}): void {
    this.logger.error(scrubAddresses(message), {
      ...(redact(extra) as LogExtra),
      ...(error === undefined ? {} : { error: describeError(error) }),
    });
  }
}

export class PowertoolsTelemetry implements Telemetry {
  constructor(
    private readonly metrics: Metrics,
    private readonly log: SafeLog,
  ) {}

  count(name: MetricName, value = 1): void {
    try {
      this.metrics.addMetric(name, MetricUnit.Count, value);
    } catch (error) {
      this.log.warn('metric dropped', { metric: name, error: describeError(error) });
    }
  }

  flush(): void {
    try {
      this.metrics.publishStoredMetrics();
    } catch (error) {
      this.log.warn('metrics flush failed', { error: describeError(error) });
    }
  }
}

export interface Observability {
  log: SafeLog;
  telemetry: Telemetry;
  tracer: Tracer;
}

export function createObservability(serviceName: string): Observability {
  const resolvedService = process.env.POWERTOOLS_SERVICE_NAME ?? serviceName;
  const logger = new Logger({ serviceName: resolvedService });
  const log = new SafeLog(logger);
  const metrics = new Metrics({
    serviceName: resolvedService,
    namespace: process.env.POWERTOOLS_METRICS_NAMESPACE ?? 'EmailDelivery',
  });
  const tracer = new Tracer({ serviceName: resolvedService });
  return { log, telemetry: new PowertoolsTelemetry(metrics, log), tracer };
}

/** Manual handler subsegment (no middleware dependency); a no-op when tracing is off. */
export async function traced<T>(tracer: Tracer, name: string, run: () => Promise<T>): Promise<T> {
  if (!tracer.isTracingEnabled()) return run();
  const parent = tracer.getSegment();
  const subsegment = parent?.addNewSubsegment(`## ${name}`);
  if (subsegment) tracer.setSegment(subsegment);
  tracer.annotateColdStart();
  tracer.addServiceNameAnnotation();
  try {
    return await run();
  } catch (error) {
    subsegment?.addError(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    subsegment?.close();
    if (parent) tracer.setSegment(parent);
  }
}

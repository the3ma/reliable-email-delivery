import {
  DeliveryStatus,
  EmailMessageSchema,
  checkSuppression,
  claimDelivery,
  classifySendError,
  describeError,
  describeIssues,
  isHardDisabled,
  maskEmail,
  messageLimitViolation,
  recordDeliveryEvent,
  retentionExpiry,
  omitBody,
} from '@mail/core';
import type {
  AccountSuppressionList,
  DeliveriesStore,
  DeliveryMeta,
  DeliveryLogEntry,
  DeliveryLogWriter,
  EmailMessage,
  MailTransport,
  SuppressionStore,
  ToggleCache,
  Toggles,
} from '@mail/core';
import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import type { SafeLog, Telemetry } from '../lib/observability.js';
import { processBatch } from '../lib/sqs-batch.js';
import type { RecordOutcome } from '../lib/sqs-batch.js';

export interface ProcessorDeps {
  deliveries: DeliveriesStore;
  deliveryLog: DeliveryLogWriter;
  suppressions: SuppressionStore;
  accountSuppressions?: AccountSuppressionList | undefined;
  transport: MailTransport;
  toggles: ToggleCache;
  log: SafeLog;
  telemetry: Telemetry;
  fromAddress: string;
  /** Raw env value of SENDING_HARD_DISABLED. */
  hardDisabled: string | undefined;
  clock?: () => Date;
  minRemainingMs?: number;
}

type ProcessorContext = Pick<Context, 'awsRequestId' | 'getRemainingTimeInMillis'>;

function metaOf(message: EmailMessage): DeliveryMeta {
  return {
    userId: message.userId,
    category: message.category,
    kind: message.kind,
    toMasked: maskEmail(message.to),
  };
}

/** Loggable view of a message: never the address, never a body, subject only when allowed. */
function describeMessage(message: EmailMessage): Record<string, unknown> {
  return {
    deliveryId: message.deliveryId,
    userId: message.userId,
    to: maskEmail(message.to),
    templateId: message.templateId,
    category: message.category,
    kind: message.kind,
    requestIds: message.requestIds.length,
    subject: message.redact ? omitBody(message.subject) : message.subject,
  };
}

export function createProcessor(deps: ProcessorDeps) {
  const clock = deps.clock ?? (() => new Date());
  const { log, telemetry } = deps;

  async function audit(
    toggles: Toggles,
    entry: Omit<DeliveryLogEntry, 'at'> & { at?: Date },
  ): Promise<void> {
    if (!toggles.recordDeliveries) return;
    await recordDeliveryEvent(
      { ...entry, at: entry.at ?? clock() },
      {
        writer: deps.deliveryLog,
        onError: (error, ref) => {
          log.warn('delivery-log write failed', { ...ref, error: describeError(error) });
        },
      },
    );
  }

  async function skip(
    message: EmailMessage,
    reason: string,
    toggles: Toggles,
    extra: Record<string, unknown> = {},
  ): Promise<RecordOutcome> {
    const now = clock();
    const written = await deps.deliveries.skip(
      message.deliveryId,
      reason,
      now,
      retentionExpiry(now),
      metaOf(message),
    );
    telemetry.count('EmailsSkipped');
    log.info('delivery skipped', { ...describeMessage(message), reason, written, ...extra });
    await audit(toggles, {
      deliveryId: message.deliveryId,
      event: 'skipped',
      details: { reason, ...extra },
    });
    return 'done';
  }

  /** After SES accepted the message nothing may throw: every side effect is isolated. */
  async function afterSend(name: string, run: () => Promise<void> | void): Promise<void> {
    try {
      await run();
    } catch (error) {
      log.error(`post-send step failed: ${name}`, error);
    }
  }

  async function processRecord(record: SQSRecord, owner: string): Promise<RecordOutcome> {
    telemetry.count('MessagesReceived');
    let json: unknown;
    try {
      json = JSON.parse(record.body);
    } catch {
      telemetry.count('InvalidMessages');
      log.warn('invalid message: not JSON', { messageId: record.messageId, body: record.body });
      return 'done';
    }
    const parsed = EmailMessageSchema.safeParse(json);
    if (!parsed.success) {
      telemetry.count('InvalidMessages');
      log.warn('invalid message: schema', {
        messageId: record.messageId,
        issues: describeIssues(parsed.error),
      });
      return 'done';
    }
    const message = parsed.data;
    const toggles = await deps.toggles.get();

    const violation = messageLimitViolation(message, Buffer.byteLength(record.body, 'utf8'));
    if (violation) {
      telemetry.count('InvalidMessages');
      return skip(message, `invalid:${violation}`, toggles);
    }

    if (isHardDisabled(deps.hardDisabled) || !toggles.sendEmails) {
      return skip(message, 'disabled', toggles, {
        hardSwitch: isHardDisabled(deps.hardDisabled),
        toggleSource: toggles.source,
      });
    }

    const suppression = await checkSuppression(message.to, {
      store: deps.suppressions,
      accountList: deps.accountSuppressions,
    });
    if (suppression.suppressed) {
      telemetry.count('Suppressed');
      return skip(message, 'suppressed', toggles, { suppressionSource: suppression.source });
    }

    const claim = await claimDelivery(deps.deliveries, {
      deliveryId: message.deliveryId,
      owner,
      now: clock(),
      meta: metaOf(message),
    });
    switch (claim.kind) {
      case 'duplicate':
        telemetry.count('DuplicatesSuppressed');
        log.info('duplicate dropped', { ...describeMessage(message), status: claim.status });
        return 'done';
      case 'contended':
        telemetry.count('ClaimContention');
        log.info('claim held by another worker; retrying later', describeMessage(message));
        return 'retry';
      case 'ambiguous':
        telemetry.count('AmbiguousDeliveries');
        log.warn('expired claim found: marked AMBIGUOUS, not resending', describeMessage(message));
        await audit(toggles, {
          deliveryId: message.deliveryId,
          event: 'ambiguous',
          details: { reason: 'lease_expired' },
        });
        return 'done';
      case 'claimed':
        break;
    }
    await audit(toggles, { deliveryId: message.deliveryId, event: 'claimed', details: { owner } });

    let messageId: string;
    try {
      ({ messageId } = await deps.transport.send({
        from: deps.fromAddress,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        tags: { deliveryId: message.deliveryId, category: message.category },
      }));
    } catch (error) {
      return onSendError(message, owner, claim.leaseUntil, error, toggles);
    }

    await afterSend('metric', () => {
      telemetry.count('EmailsSent');
    });
    await afterSend('mark', async () => {
      let marked: boolean;
      try {
        marked = await deps.deliveries.complete(message.deliveryId, owner, clock(), {
          status: DeliveryStatus.SENT,
          sesMessageId: messageId,
        });
      } catch (error) {
        // The item stays CLAIMED until its lease expires; any later copy of this message then
        // finds an expired lease (AMBIGUOUS) and does not resend.
        telemetry.count('MarkFailures');
        log.error('mark SENT failed (e-mail is out)', error, describeMessage(message));
        return;
      }
      if (!marked) {
        telemetry.count('MarkFailures');
        log.error('mark SENT lost the lease (e-mail is out)', undefined, describeMessage(message));
      }
    });
    await afterSend('log', () => {
      log.info('e-mail sent', { ...describeMessage(message), sesMessageId: messageId });
    });
    await afterSend('audit', () =>
      audit(toggles, {
        deliveryId: message.deliveryId,
        event: 'sent',
        details: { sesMessageId: messageId, transport: deps.transport.name },
      }),
    );
    return 'done';
  }

  async function onSendError(
    message: EmailMessage,
    owner: string,
    leaseUntil: number,
    error: unknown,
    toggles: Toggles,
  ): Promise<RecordOutcome> {
    const classification = classifySendError(error);
    const summary = describeError(error);
    const now = clock();

    if (classification === 'unknown') {
      telemetry.count('AmbiguousDeliveries');
      const marked = await safely(() =>
        deps.deliveries.markAmbiguous({
          deliveryId: message.deliveryId,
          leaseOwner: owner,
          leaseUntil,
          now,
        }),
      );
      log.error('send outcome unknown: marked AMBIGUOUS, not retrying', error, {
        ...describeMessage(message),
        marked,
      });
      await audit(toggles, {
        deliveryId: message.deliveryId,
        event: 'ambiguous',
        details: { ...summary },
      });
      return 'done';
    }

    if (classification === 'permanent') {
      telemetry.count('PermanentFailures');
      await safely(() =>
        deps.deliveries.complete(message.deliveryId, owner, now, {
          status: DeliveryStatus.FAILED_PERMANENT,
          reason: summary.errorName,
        }),
      );
      log.error('permanent send failure', error, describeMessage(message));
      await audit(toggles, {
        deliveryId: message.deliveryId,
        event: 'failed',
        details: { ...summary },
      });
      return 'done';
    }

    telemetry.count('TransientFailures');
    // If the release itself fails the lease simply expires; the retry then sees AMBIGUOUS, which
    // is the safe direction for an at-most-once policy.
    await safely(() =>
      deps.deliveries.complete(message.deliveryId, owner, now, {
        status: DeliveryStatus.RELEASED,
        reason: summary.errorName,
      }),
    );
    log.warn('transient send failure: released for retry', {
      ...describeMessage(message),
      error: summary,
    });
    await audit(toggles, {
      deliveryId: message.deliveryId,
      event: 'released',
      details: { ...summary },
    });
    return 'retry';
  }

  async function safely<T>(run: () => Promise<T>): Promise<T | 'error'> {
    try {
      return await run();
    } catch (error) {
      log.error('deliveries update failed', error);
      return 'error';
    }
  }

  return async function processor(
    event: SQSEvent,
    context: ProcessorContext,
  ): Promise<SQSBatchResponse> {
    try {
      return await processBatch(
        event.Records,
        context,
        (record) => processRecord(record, context.awsRequestId),
        {
          ...(deps.minRemainingMs === undefined ? {} : { minRemainingMs: deps.minRemainingMs }),
          onDeadline: (unprocessed, remainingMs) => {
            log.warn('deadline guard: returning unprocessed records', { unprocessed, remainingMs });
          },
          onUnexpectedError: (error, record) => {
            telemetry.count('TransientFailures');
            log.error('record failed before send; will retry', error, {
              messageId: record.messageId,
            });
          },
        },
      );
    } finally {
      telemetry.flush();
    }
  };
}

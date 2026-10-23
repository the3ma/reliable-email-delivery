import {
  NotificationRequestSchema,
  TemplateError,
  describeIssues,
  epochSeconds,
  hasImmediateTemplate,
  immediateDeliveryId,
  isRedactedCategory,
  maskEmail,
  messageLimitViolation,
  pendingDigestSortKey,
  renderImmediate,
} from '@mail/core';
import type {
  DeliveriesStore,
  EmailMessage,
  NotificationRequest,
  PendingDigestRepository,
  Subscription,
  SubscriptionsRepository,
} from '@mail/core';
import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import type { EmailQueue } from '../lib/email-queue.js';
import type { SafeLog, Telemetry } from '../lib/observability.js';
import { processBatch } from '../lib/sqs-batch.js';
import type { RecordOutcome } from '../lib/sqs-batch.js';

export const PENDING_DIGEST_TTL_DAYS = 14;

export interface NotifierImmediateDeps {
  subscriptions: SubscriptionsRepository;
  pendingDigest: PendingDigestRepository;
  deliveries: DeliveriesStore;
  emailQueue: EmailQueue;
  log: SafeLog;
  telemetry: Telemetry;
  appBaseUrl: string;
  clock?: () => Date;
  minRemainingMs?: number;
}

export type Route = 'immediate' | 'digest' | 'none';

/** Immediate only when the user asked for it and a template exists; otherwise the digest. */
export function routeFor(subscription: Subscription, request: NotificationRequest): Route {
  const { category } = request;
  if (subscription.immediate.includes(category)) {
    return hasImmediateTemplate(category) ? 'immediate' : 'digest';
  }
  return subscription.digest.includes(category) ? 'digest' : 'none';
}

type NotifierContext = Pick<Context, 'getRemainingTimeInMillis'>;

export function createNotifierImmediate(deps: NotifierImmediateDeps) {
  const clock = deps.clock ?? (() => new Date());
  const { log, telemetry } = deps;

  async function queueDigestItem(request: NotificationRequest, subscription: Subscription) {
    await deps.pendingDigest.add({
      userId: request.userId,
      sk: pendingDigestSortKey(request.occurredAt, request.requestId),
      requestId: request.requestId,
      category: request.category,
      entityId: request.entityId,
      occurredAt: request.occurredAt,
      data: request.data,
      segment: subscription.segment,
      expiresAt: epochSeconds(clock()) + PENDING_DIGEST_TTL_DAYS * 24 * 60 * 60,
    });
    log.info('queued for digest', {
      requestId: request.requestId,
      userId: request.userId,
      category: request.category,
    });
  }

  async function sendImmediate(
    request: NotificationRequest,
    subscription: Subscription,
  ): Promise<RecordOutcome> {
    if (!hasImmediateTemplate(request.category)) throw new Error('route/template mismatch');
    const deliveryId = immediateDeliveryId(request.userId, request.category, request.entityId);
    const ref = {
      requestId: request.requestId,
      userId: request.userId,
      deliveryId,
      category: request.category,
    };

    // Cheap upstream dedup; the processor's claim is the real guarantee.
    if (await deps.deliveries.get(deliveryId)) {
      telemetry.count('DuplicatesSuppressed');
      log.info('already delivered; not queueing', ref);
      return 'done';
    }

    let rendered;
    try {
      rendered = renderImmediate(request.category, request, deps.appBaseUrl);
    } catch (error) {
      if (!(error instanceof TemplateError)) throw error;
      // A missing variable is a bad request, not a reason to send a half-empty e-mail.
      telemetry.count('InvalidMessages');
      log.warn('invalid request: template could not render', { ...ref, reason: error.message });
      return 'done';
    }

    const message: EmailMessage = {
      deliveryId,
      userId: request.userId,
      to: subscription.email,
      templateId: request.category,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      category: request.category,
      kind: 'immediate',
      requestIds: [request.requestId],
      redact: isRedactedCategory(request.category),
      createdAt: clock().toISOString(),
    };
    const violation = messageLimitViolation(message, Buffer.byteLength(JSON.stringify(message)));
    if (violation) {
      telemetry.count('InvalidMessages');
      log.warn('invalid request: rendered e-mail exceeds the limits', {
        ...ref,
        reason: violation,
      });
      return 'done';
    }
    await deps.emailQueue.send(message);
    telemetry.count('NotificationsQueued');
    log.info('queued immediate e-mail', { ...ref, to: maskEmail(subscription.email) });
    return 'done';
  }

  async function processRecord(record: SQSRecord): Promise<RecordOutcome> {
    telemetry.count('MessagesReceived');
    let json: unknown;
    try {
      json = JSON.parse(record.body);
    } catch {
      telemetry.count('InvalidMessages');
      log.warn('invalid request: not JSON', { messageId: record.messageId, body: record.body });
      return 'done';
    }
    const parsed = NotificationRequestSchema.safeParse(json);
    if (!parsed.success) {
      telemetry.count('InvalidMessages');
      log.warn('invalid request: schema', {
        messageId: record.messageId,
        issues: describeIssues(parsed.error),
      });
      return 'done';
    }
    const request = parsed.data;

    const subscription = await deps.subscriptions.get(request.userId);
    if (!subscription) {
      telemetry.count('EmailsSkipped');
      log.info('no subscription; dropping', {
        requestId: request.requestId,
        userId: request.userId,
      });
      return 'done';
    }

    switch (routeFor(subscription, request)) {
      case 'immediate':
        return sendImmediate(request, subscription);
      case 'digest':
        await queueDigestItem(request, subscription);
        return 'done';
      case 'none':
        telemetry.count('EmailsSkipped');
        log.info('category not subscribed; dropping', {
          requestId: request.requestId,
          userId: request.userId,
          category: request.category,
        });
        return 'done';
    }
  }

  return async function notifierImmediate(
    event: SQSEvent,
    context: NotifierContext,
  ): Promise<SQSBatchResponse> {
    try {
      return await processBatch(event.Records, context, processRecord, {
        ...(deps.minRemainingMs === undefined ? {} : { minRemainingMs: deps.minRemainingMs }),
        onDeadline: (unprocessed, remainingMs) => {
          log.warn('deadline guard: returning unprocessed records', { unprocessed, remainingMs });
        },
        onUnexpectedError: (error, record) => {
          log.error('request failed; will retry', error, { messageId: record.messageId });
        },
      });
    } finally {
      telemetry.flush();
    }
  };
}

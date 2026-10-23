import {
  DEFAULT_DIGEST_WINDOW,
  MAX_DIGEST_ITEMS,
  uniqueDigestEntries,
  buildDigestView,
  describeError,
  digestDeliveryId,
  digestDue,
  isValidTimeZone,
  maskEmail,
  messageLimitViolation,
  renderDigest,
} from '@mail/core';
import type {
  DeliveriesStore,
  DigestWindow,
  EmailMessage,
  PendingDigestItem,
  PendingDigestRepository,
  Subscription,
  SubscriptionsRepository,
} from '@mail/core';
import { z } from 'zod';
import type { EmailQueue } from '../lib/email-queue.js';
import type { SafeLog, Telemetry } from '../lib/observability.js';

export interface NotifierDigestDeps {
  subscriptions: SubscriptionsRepository;
  pendingDigest: PendingDigestRepository;
  deliveries: DeliveriesStore;
  emailQueue: EmailQueue;
  log: SafeLog;
  telemetry: Telemetry;
  appBaseUrl: string;
  segments: number;
  window?: DigestWindow;
  concurrency?: number;
  /** Stop starting users when less than this is left (default 30 s). */
  minRemainingMs?: number;
  clock?: () => Date;
}

export interface DigestRunResult {
  segment: number;
  users: number;
  due: number;
  queued: number;
  alreadyDelivered: number;
  nothingPending: number;
  failed: number;
  /** Due users not started because the deadline was near; a re-run picks them up. */
  remaining: number;
  invalidSubscriptions: number;
  /** E-mails queued, counting every part of a split digest. */
  messages: number;
}

type UserOutcome = 'queued' | 'alreadyDelivered' | 'nothingPending' | 'failed';

interface DigestContext {
  getRemainingTimeInMillis(): number;
}

export function createNotifierDigest(deps: NotifierDigestDeps) {
  const clock = deps.clock ?? (() => new Date());
  const window = deps.window ?? DEFAULT_DIGEST_WINDOW;
  const concurrency = Math.max(1, deps.concurrency ?? 8);
  const minRemainingMs = deps.minRemainingMs ?? 30_000;
  const { log, telemetry } = deps;
  const EventSchema = z.object({
    segment: z
      .number()
      .int()
      .min(0)
      .max(deps.segments - 1),
  });

  async function digestFor(
    subscription: Subscription,
    localDate: string,
    now: Date,
  ): Promise<{ outcome: UserOutcome; messages: number }> {
    const { userId } = subscription;
    const singleId = digestDeliveryId(userId, localDate);
    const ref = { userId, deliveryId: singleId, localDate };
    // Part ids do not depend on the part count, so "part 1 exists" means a split digest went out.
    const firstPartId = digestDeliveryId(userId, localDate, { index: 1, total: 2 });
    if ((await deps.deliveries.get(singleId)) ?? (await deps.deliveries.get(firstPartId))) {
      // Items that arrived after today's digest stay pending for tomorrow.
      return { outcome: 'alreadyDelivered', messages: 0 };
    }
    const { items, invalid } = await deps.pendingDigest.listForUser(userId);
    if (invalid > 0) log.warn('pending-digest rows failed validation', { ...ref, invalid });
    if (items.length === 0) return { outcome: 'nothingPending', messages: 0 };

    const messages = planDigest(subscription, localDate, now, items);
    for (const message of messages) {
      await deps.emailQueue.send(message);
      telemetry.count('NotificationsQueued');
    }
    telemetry.count('DigestUsers');
    log.info('queued digest', {
      ...ref,
      to: maskEmail(subscription.email),
      items: items.length,
      parts: messages.length,
    });

    try {
      await deps.pendingDigest.remove(
        userId,
        items.map((item) => item.sk),
      );
    } catch (error) {
      // Not fatal for today: the delivery ids are fixed, so a re-run cannot send today's digest twice.
      log.warn('could not clear pending items; they will reappear in the next digest', {
        ...ref,
        error: describeError(error),
      });
    }
    return { outcome: 'queued', messages: messages.length };
  }

  /**
   * One message when it fits the processor's limits (contract section 6); otherwise the items are
   * split into parts, each with its own delivery id (period = local date + "#p" + n), doubling
   * the part count until every part fits.
   */
  function planDigest(
    subscription: Subscription,
    localDate: string,
    now: Date,
    items: readonly PendingDigestItem[],
  ): EmailMessage[] {
    const unique = uniqueDigestEntries(items);
    const keyOf = (entry: { category: string; entityId: string }) =>
      `${entry.category}|${entry.entityId}`;
    const requestIdsByKey = new Map<string, string[]>();
    for (const item of items) {
      const ids = requestIdsByKey.get(keyOf(item)) ?? [];
      ids.push(item.requestId);
      requestIdsByKey.set(keyOf(item), ids);
    }

    const build = (
      chunk: readonly PendingDigestItem[],
      index: number,
      total: number,
    ): EmailMessage => {
      const part = { index, total };
      const rendered = renderDigest(
        buildDigestView(chunk, localDate, deps.appBaseUrl, chunk.length, part),
      );
      return {
        deliveryId: digestDeliveryId(subscription.userId, localDate, part),
        userId: subscription.userId,
        to: subscription.email,
        templateId: 'digest',
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        category: 'digest',
        kind: 'digest',
        requestIds: [...new Set(chunk.flatMap((entry) => requestIdsByKey.get(keyOf(entry)) ?? []))],
        redact: false,
        createdAt: now.toISOString(),
      };
    };
    const fits = (message: EmailMessage) =>
      messageLimitViolation(message, Buffer.byteLength(JSON.stringify(message), 'utf8')) ===
      undefined;

    let wanted = Math.max(1, Math.ceil(unique.length / MAX_DIGEST_ITEMS));
    for (;;) {
      const size = Math.ceil(unique.length / wanted);
      const chunks: PendingDigestItem[][] = [];
      for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
      const messages = chunks.map((chunk, i) => build(chunk, i + 1, chunks.length));
      if (messages.every(fits)) return messages;
      if (size === 1) {
        // A single item cannot be split further; the processor rejects it as permanent.
        log.warn('digest item exceeds the message limits on its own', {
          userId: subscription.userId,
        });
        return messages;
      }
      wanted *= 2;
    }
  }

  return async function notifierDigest(
    event: unknown,
    context: DigestContext,
  ): Promise<DigestRunResult> {
    const parsed = EventSchema.safeParse(event);
    if (!parsed.success)
      throw new Error(`invalid digest event: expected { segment: 0..${deps.segments - 1} }`);
    const { segment } = parsed.data;
    const now = clock();

    try {
      const { items: subscriptions, invalid } = await deps.subscriptions.listBySegment(segment);
      const due: { subscription: Subscription; localDate: string }[] = [];
      for (const subscription of subscriptions) {
        if (!isValidTimeZone(subscription.timezone)) {
          log.warn('subscription has an invalid timezone; skipped', {
            userId: subscription.userId,
          });
          continue;
        }
        const check = digestDue(now, subscription.timezone, window);
        if (check.due) due.push({ subscription, localDate: check.localDate });
      }

      const result: DigestRunResult = {
        segment,
        users: subscriptions.length,
        due: due.length,
        queued: 0,
        alreadyDelivered: 0,
        nothingPending: 0,
        failed: 0,
        remaining: 0,
        messages: 0,
        invalidSubscriptions: invalid,
      };

      // Bounded worker pool over a shared cursor; each worker checks the deadline before taking a user.
      let cursor = 0;
      let stopped = false;
      const worker = async (): Promise<void> => {
        for (;;) {
          if (stopped || cursor >= due.length) return;
          if (context.getRemainingTimeInMillis() < minRemainingMs) {
            stopped = true;
            return;
          }
          const next = due[cursor];
          cursor += 1;
          if (!next) return;
          try {
            const done = await digestFor(next.subscription, next.localDate, now);
            result[done.outcome] += 1;
            result.messages += done.messages;
          } catch (error) {
            result.failed += 1;
            log.error('digest failed for user', error, { userId: next.subscription.userId });
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, Math.max(1, due.length)) }, worker),
      );
      result.remaining = due.length - cursor;

      if (result.remaining > 0) {
        log.warn('stopping before the deadline; re-run the segment to finish', { ...result });
      }
      log.info('digest segment done', { ...result });
      if (result.failed > 0) {
        // Fail the invocation so it is alarmed; a manual re-run is safe (queued users are skipped).
        throw new Error(`digest segment ${segment}: ${result.failed} user(s) failed`);
      }
      return result;
    } finally {
      telemetry.flush();
    }
  };
}

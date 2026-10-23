import { describeError, emailHash, maskEmail, recordDeliveryEvent } from '@mail/core';
import type {
  DeliveryLogEvent,
  DeliveryLogWriter,
  SuppressionReason,
  SuppressionStore,
} from '@mail/core';
import { z } from 'zod';
import type { SafeLog, Telemetry } from '../lib/observability.js';

const Recipient = z.object({ emailAddress: z.string() }).loose();

/** The SES v2 event-destination payload as delivered by EventBridge (`detail`). */
export const SesEventSchema = z.object({
  source: z.string().optional(),
  'detail-type': z.string().optional(),
  time: z.string().optional(),
  detail: z
    .object({
      eventType: z.string(),
      mail: z
        .object({
          messageId: z.string(),
          timestamp: z.string().optional(),
          tags: z.record(z.string(), z.array(z.string())).optional(),
        })
        .loose(),
      bounce: z
        .object({
          bounceType: z.string(),
          bounceSubType: z.string().optional(),
          bouncedRecipients: z.array(Recipient),
          timestamp: z.string().optional(),
        })
        .loose()
        .optional(),
      complaint: z
        .object({
          complainedRecipients: z.array(Recipient),
          complaintFeedbackType: z.string().optional(),
          timestamp: z.string().optional(),
        })
        .loose()
        .optional(),
      delivery: z
        .object({ recipients: z.array(z.string()).optional(), timestamp: z.string().optional() })
        .loose()
        .optional(),
      reject: z.object({ reason: z.string().optional() }).loose().optional(),
    })
    .loose(),
});
export type SesEvent = z.infer<typeof SesEventSchema>;

export interface FeedbackDeps {
  suppressions: SuppressionStore;
  deliveryLog: DeliveryLogWriter;
  log: SafeLog;
  telemetry: Telemetry;
  clock?: () => Date;
}

export interface FeedbackResult {
  eventType: string;
  suppressed: number;
  deliveryId: string | undefined;
}

const LOG_EVENT: Readonly<Record<string, DeliveryLogEvent>> = {
  Bounce: 'bounced',
  Complaint: 'complained',
  Delivery: 'delivered',
  Reject: 'rejected',
};

export function createFeedback(deps: FeedbackDeps) {
  const clock = deps.clock ?? (() => new Date());
  const { log, telemetry } = deps;

  async function suppress(
    addresses: readonly string[],
    reason: SuppressionReason,
    source: string,
    at: Date,
  ) {
    for (const address of addresses) {
      await deps.suppressions.upsert({ emailHash: emailHash(address), reason, source, at });
    }
    if (addresses.length > 0) telemetry.count('Suppressed', addresses.length);
  }

  return async function feedback(event: unknown): Promise<FeedbackResult | undefined> {
    try {
      const parsed = SesEventSchema.safeParse(event);
      if (!parsed.success) {
        telemetry.count('InvalidMessages');
        log.warn('feedback event has an unexpected shape; ignored');
        return undefined;
      }
      const { detail } = parsed.data;
      const at = clock();
      const deliveryId = detail.mail.tags?.deliveryId?.[0];
      telemetry.count('FeedbackEvents');

      let suppressed: string[] = [];
      const details: Record<string, unknown> = {
        eventType: detail.eventType,
        sesMessageId: detail.mail.messageId,
      };

      switch (detail.eventType) {
        case 'Bounce': {
          telemetry.count('Bounces');
          const bounce = detail.bounce;
          const recipients = bounce?.bouncedRecipients.map((r) => r.emailAddress) ?? [];
          Object.assign(details, {
            bounceType: bounce?.bounceType,
            bounceSubType: bounce?.bounceSubType,
            recipients: recipients.map(maskEmail),
          });
          // Only a permanent bounce says the address is bad; transient ones are logged and retried by SES.
          if (bounce?.bounceType === 'Permanent') {
            suppressed = recipients;
            await suppress(recipients, 'bounce_permanent', 'ses-bounce', at);
          }
          break;
        }
        case 'Complaint': {
          telemetry.count('Complaints');
          const recipients =
            detail.complaint?.complainedRecipients.map((r) => r.emailAddress) ?? [];
          Object.assign(details, {
            feedbackType: detail.complaint?.complaintFeedbackType,
            recipients: recipients.map(maskEmail),
          });
          suppressed = recipients;
          await suppress(recipients, 'complaint', 'ses-complaint', at);
          break;
        }
        case 'Reject':
          details.reason = detail.reject?.reason;
          break;
        default:
          break;
      }

      log.info('ses feedback processed', { ...details, deliveryId, suppressed: suppressed.length });

      if (deliveryId) {
        await recordDeliveryEvent(
          { deliveryId, event: LOG_EVENT[detail.eventType] ?? 'feedback', at, details },
          {
            writer: deps.deliveryLog,
            onError: (error, ref) => {
              log.warn('delivery-log write failed', { ...ref, error: describeError(error) });
            },
          },
        );
      } else {
        log.warn('ses event without a deliveryId tag; no delivery-log row', {
          eventType: detail.eventType,
        });
      }
      return { eventType: detail.eventType, suppressed: suppressed.length, deliveryId };
    } finally {
      telemetry.flush();
    }
  };
}

import { randomUUID } from 'node:crypto';

export type SesEventType = 'Bounce' | 'Complaint' | 'Delivery' | 'Reject';

const DETAIL_TYPES: Readonly<Record<SesEventType, string>> = {
  Bounce: 'Email Bounced',
  Complaint: 'Email Complaint Received',
  Delivery: 'Email Delivered',
  Reject: 'Email Rejected',
};

export interface SesEventOptions {
  type: SesEventType;
  email: string;
  deliveryId?: string | undefined;
  bounceType?: 'Permanent' | 'Transient' | 'Undetermined';
  at?: Date;
  from?: string;
}

/**
 * Builds the event SES v2 publishes to EventBridge through an event destination, so local runs
 * and tests exercise the same parsing as production.
 */
export function buildSesEvent(options: SesEventOptions): Record<string, unknown> {
  const at = (options.at ?? new Date()).toISOString();
  const messageId = `local-${randomUUID()}`;
  const tags: Record<string, string[]> = { 'ses:configuration-set': ['local'] };
  if (options.deliveryId) tags.deliveryId = [options.deliveryId];

  const detail: Record<string, unknown> = {
    eventType: options.type,
    mail: {
      timestamp: at,
      source: options.from ?? 'notifications@example.test',
      messageId,
      destination: [options.email],
      tags,
    },
  };
  switch (options.type) {
    case 'Bounce': {
      const permanent = (options.bounceType ?? 'Permanent') === 'Permanent';
      detail.bounce = {
        feedbackId: randomUUID(),
        bounceType: options.bounceType ?? 'Permanent',
        bounceSubType: permanent ? 'General' : 'MailboxFull',
        bouncedRecipients: [
          {
            emailAddress: options.email,
            action: 'failed',
            status: permanent ? '5.1.1' : '4.2.2',
            diagnosticCode: `smtp; ${permanent ? '550 5.1.1' : '452 4.2.2'} <${options.email}>: recipient rejected`,
          },
        ],
        timestamp: at,
      };
      break;
    }
    case 'Complaint':
      detail.complaint = {
        feedbackId: randomUUID(),
        complainedRecipients: [{ emailAddress: options.email }],
        complaintFeedbackType: 'abuse',
        timestamp: at,
      };
      break;
    case 'Delivery':
      detail.delivery = {
        timestamp: at,
        recipients: [options.email],
        smtpResponse: '250 2.0.0 OK',
      };
      break;
    case 'Reject':
      detail.reject = { reason: 'Bad content' };
      break;
  }
  return {
    version: '0',
    id: randomUUID(),
    'detail-type': DETAIL_TYPES[options.type],
    source: 'aws.ses',
    account: '000000000000',
    time: at,
    region: process.env.AWS_REGION ?? 'us-east-1',
    resources: [],
    detail,
  };
}

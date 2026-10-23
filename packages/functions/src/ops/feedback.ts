import type { FeedbackResult } from '../app/feedback.js';
import { buildSesEvent } from '../app/ses-events.js';
import type { SesEventType } from '../app/ses-events.js';

export type FeedbackRunner = (event: unknown) => Promise<FeedbackResult | undefined>;

export const FEEDBACK_TYPES: Readonly<Record<string, SesEventType>> = {
  bounce: 'Bounce',
  complaint: 'Complaint',
  delivery: 'Delivery',
  reject: 'Reject',
};

export interface SimulateFeedbackOptions {
  type: keyof typeof FEEDBACK_TYPES;
  email: string;
  transient?: boolean | undefined;
  deliveryId?: string | undefined;
}

/** Builds the real SES v2 EventBridge event and hands it to the feedback handler logic. */
export async function simulateFeedback(
  runner: FeedbackRunner,
  options: SimulateFeedbackOptions,
): Promise<FeedbackResult | undefined> {
  const type = FEEDBACK_TYPES[options.type];
  if (!type) throw new Error(`unknown feedback type ${options.type}`);
  return runner(
    buildSesEvent({
      type,
      email: options.email,
      deliveryId: options.deliveryId,
      bounceType: options.transient ? 'Transient' : 'Permanent',
    }),
  );
}

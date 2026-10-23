/** Wire types of console-api `/api/v1` (docs/CONSOLE.md). */

export const DELIVERY_STATUSES = [
  'SENT',
  'SKIPPED',
  'RELEASED',
  'CLAIMED',
  'FAILED_PERMANENT',
  'AMBIGUOUS',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const CATEGORIES = [
  'report_ready',
  'invoice_failed',
  'comment_added',
  'usage_alert',
  'digest',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const KINDS = ['immediate', 'digest'] as const;
export type Kind = (typeof KINDS)[number];

export type ToggleValue = 'enabled' | 'disabled';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Health {
  status: string;
  checks: Record<string, string>;
}

export interface QueueDepth {
  visible: number;
  inFlight: number;
}

export interface Toggles {
  sendEmails: ToggleValue;
  recordDeliveries: ToggleValue;
}

export interface Overview {
  counts: Record<DeliveryStatus, number>;
  skippedByReason: Record<string, number>;
  queues: {
    intake: QueueDepth;
    intakeDlq: QueueDepth;
    email: QueueDepth;
    emailDlq: QueueDepth;
  };
  toggles: Toggles;
  mail: { total: number };
  suppressions: { total: number };
  subscriptions: { total: number };
}

export interface ToggleUpdate {
  value: ToggleValue;
  note: string;
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  expected: string;
}

export interface ScenarioRun {
  runId: string;
  startedAt: string;
  published: number;
  notes: string[];
}

export type ScenarioRunPhase = 'running' | 'done' | 'failed';

/** GET /scenarios/runs/{runId}: background scenarios append notes while they run. */
export interface ScenarioRunStatus extends ScenarioRun {
  scenario: string;
  status: ScenarioRunPhase;
  finishedAt?: string | null;
}

export interface DeliverySummary {
  deliveryId: string;
  status: DeliveryStatus;
  reason?: string | null;
  category: string | null;
  kind: string | null;
  userId: string | null;
  toMasked: string | null;
  attempts: number;
  updatedAt: string;
}

export interface DeliveryEvent {
  at: string;
  event: string;
  details?: Record<string, unknown> | null;
}

export interface DeliveryDetail extends DeliverySummary {
  events: DeliveryEvent[];
  mailId?: string | null;
}

export interface Suppression {
  emailHash: string;
  reason: string;
  source: string;
  createdAt: string;
  lastEventAt: string;
}

export type FeedbackType = 'bounce' | 'complaint' | 'delivery';

export interface FeedbackRequest {
  type: FeedbackType;
  email: string;
  transient?: boolean;
}

export interface FeedbackResult {
  ok: boolean;
  suppressed: boolean;
}

export interface DigestRequest {
  segment?: number;
  all?: true;
  ignoreWindow?: true;
}

export interface DigestResult {
  users: number;
  queued: number;
  alreadyDelivered: number;
  parts: number;
  due?: number;
  nothingPending?: number;
  remaining?: number;
  failed?: number;
  failures?: { segment: number; message: string }[];
}

export interface MailSummary {
  id: string;
  to: string | string[];
  subject: string;
  createdAt: string;
  deliveryId?: string | null;
  category?: string | null;
  size: number;
}

export interface MailMessage {
  id: string;
  to: string | string[];
  from: string;
  subject: string;
  createdAt: string;
  text: string;
  html: string;
  headers: Record<string, string[]>;
  deliveryId?: string | null;
}

import type {
  DeliveriesStore,
  DeliveryLogItem,
  DeliveryLogWriter,
  DeliveryRecord,
  PendingDigestRepository,
  SubscriptionsRepository,
  SuppressionRecord,
  SuppressionStore,
} from '@mail/core';
import type { EmailQueue, Publisher, SafeLog } from '@mail/functions';
import type { ConsoleConfig } from './config.js';

/** Table-wide reads and deletes the Lambdas never need; local demo only. */
export interface DeliveriesAdmin {
  list(): Promise<DeliveryRecord[]>;
  clear(): Promise<number>;
}

export interface DeliveryLogAdmin {
  events(deliveryId: string): Promise<DeliveryLogItem[]>;
  clear(): Promise<number>;
}

export interface SuppressionsAdmin {
  list(): Promise<SuppressionRecord[]>;
  /** Deletes every entry for which `keep` is false. */
  clear(keep: (record: SuppressionRecord) => boolean): Promise<number>;
}

export interface TableAdmin {
  count(): Promise<number>;
  clear(): Promise<number>;
}

export type QueueKey = 'intake' | 'intakeDlq' | 'email' | 'emailDlq';
export interface QueueDepth {
  visible: number;
  inFlight: number;
}

export interface QueueAdmin {
  depths(): Promise<Record<QueueKey, QueueDepth>>;
  purgeAll(): Promise<void>;
}

export type ToggleValue = 'enabled' | 'disabled';

export interface TogglesAdmin {
  get(): Promise<{ sendEmails: ToggleValue; recordDeliveries: ToggleValue }>;
  setSendEmails(value: ToggleValue): Promise<void>;
}

export interface MailSummary {
  id: string;
  messageId: string;
  to: string[];
  subject: string;
  createdAt: string;
  size: number;
}

export interface MailMessage extends MailSummary {
  from: string;
  text: string;
  html: string;
}

/** The Mailpit HTTP API, reduced to what the console shows. */
export interface MailClient {
  list(start: number, limit: number): Promise<{ total: number; messages: MailSummary[] }>;
  get(id: string): Promise<MailMessage | undefined>;
  headers(id: string): Promise<Record<string, string[]> | undefined>;
  /** Mailpit id of the message whose Message-ID header is `messageId` (no angle brackets). */
  findByMessageId(messageId: string): Promise<string | undefined>;
  deleteAll(): Promise<void>;
  ping(): Promise<boolean>;
}

export interface ConsoleDeps {
  config: ConsoleConfig;
  deliveries: DeliveriesStore;
  deliveriesAdmin: DeliveriesAdmin;
  deliveryLog: DeliveryLogWriter;
  deliveryLogAdmin: DeliveryLogAdmin;
  suppressions: SuppressionStore;
  suppressionsAdmin: SuppressionsAdmin;
  subscriptions: SubscriptionsRepository;
  subscriptionsAdmin: TableAdmin;
  pendingDigest: PendingDigestRepository;
  pendingDigestAdmin: TableAdmin;
  queues: QueueAdmin;
  toggles: TogglesAdmin;
  mail: MailClient;
  publisher: Publisher;
  /** Where the in-process digest run queues its e-mails (the real email queue). */
  emailQueue: EmailQueue;
  localstackPing: () => Promise<boolean>;
  log: SafeLog;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

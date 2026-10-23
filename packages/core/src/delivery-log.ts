import { redact } from './redaction.js';
import { epochSeconds } from './deliveries.js';

/** DynamoDB's hard limit is 400 KB; the budget leaves room for attribute-name overhead. */
export const ITEM_BUDGET_BYTES = 380 * 1024;
export const LOG_RETENTION_DAYS = 90;

export type DeliveryLogEvent =
  | 'claimed'
  | 'sent'
  | 'skipped'
  | 'failed'
  | 'released'
  | 'ambiguous'
  | 'duplicate'
  | 'mark_failed'
  | 'bounced'
  | 'complained'
  | 'delivered'
  | 'rejected'
  | 'feedback';

export interface DeliveryLogEntry {
  deliveryId: string;
  event: DeliveryLogEvent;
  at: Date;
  details: Record<string, unknown>;
}

export interface DeliveryLogItem {
  deliveryId: string;
  sk: string;
  at: string;
  event: DeliveryLogEvent;
  details: Record<string, unknown>;
  expiresAt: number;
  /** Highest shedding stage applied (0 = untouched). */
  shedStage: number;
}

export interface DeliveryLogWriter {
  put(item: DeliveryLogItem): Promise<void>;
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

const TRUNCATION_MARKER = '...[truncated]';

/** Cuts on a code-point boundary, so a multibyte character or surrogate pair is never split. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  const room = Math.max(0, maxBytes - markerBytes);
  let used = 0;
  let end = 0;
  for (const char of value) {
    const bytes = utf8Length(char.codePointAt(0) ?? 0);
    if (used + bytes > room) break;
    used += bytes;
    end += char.length;
  }
  return maxBytes >= markerBytes ? value.slice(0, end) + TRUNCATION_MARKER : value.slice(0, end);
}

function mapStrings(value: unknown, maxStringBytes: number, maxArray: number): unknown {
  if (typeof value === 'string') return truncateUtf8(value, maxStringBytes);
  if (Array.isArray(value)) {
    const kept = value.slice(0, maxArray).map((v) => mapStrings(v, maxStringBytes, maxArray));
    if (value.length > maxArray) kept.push(`[+${value.length - maxArray} more]`);
    return kept;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = mapStrings(entry, maxStringBytes, maxArray);
    }
    return out;
  }
  return value;
}

const ESSENTIAL_KEYS = [
  'reason',
  'status',
  'errorName',
  'errorMessage',
  'httpStatus',
  'sesMessageId',
  'templateId',
  'kind',
  'category',
] as const;

type Stage = (details: Record<string, unknown>, originalBytes: number) => Record<string, unknown>;

const STAGES: readonly Stage[] = [
  (details) => details,
  (details) => mapStrings(details, 8 * 1024, 1000) as Record<string, unknown>,
  (details) => mapStrings(details, 512, 20) as Record<string, unknown>,
  (details) => {
    const kept: Record<string, unknown> = {};
    for (const key of ESSENTIAL_KEYS) {
      if (key in details) kept[key] = mapStrings(details[key], 512, 5);
    }
    const dropped = Object.keys(details).filter(
      (key) => !(ESSENTIAL_KEYS as readonly string[]).includes(key),
    );
    kept.droppedKeys = mapStrings(dropped, 64, 20);
    return kept;
  },
  (_details, originalBytes) => ({ shed: 'all', originalBytes }),
];

/**
 * Builds a delivery-log item that always fits the budget: details are redacted, then shed in
 * stages, re-measuring the serialised item after every stage (JSON escaping can grow a string).
 * The entry passed in is never mutated.
 */
export function buildLogItem(
  entry: DeliveryLogEntry,
  budgetBytes: number = ITEM_BUDGET_BYTES,
): DeliveryLogItem {
  const at = entry.at.toISOString();
  const redacted = redact(entry.details) as Record<string, unknown>;
  const base = {
    deliveryId: entry.deliveryId,
    sk: `${at}#${entry.event}`,
    at,
    event: entry.event,
    expiresAt: epochSeconds(entry.at) + LOG_RETENTION_DAYS * 24 * 60 * 60,
  };
  const originalBytes = jsonBytes({ ...base, details: redacted, shedStage: 0 });
  for (const [index, stage] of STAGES.entries()) {
    const item: DeliveryLogItem = {
      ...base,
      details: stage(redacted, originalBytes),
      shedStage: index,
    };
    if (jsonBytes(item) <= budgetBytes) return item;
  }
  throw new Error('delivery-log item cannot fit the budget even without details');
}

export interface DeliveryLogOptions {
  writer: DeliveryLogWriter;
  /** Called with a redacted error summary; recording must never fail the caller. */
  onError: (error: unknown, entry: Pick<DeliveryLogEntry, 'deliveryId' | 'event'>) => void;
}

/** Best-effort audit trail: returns false instead of throwing. */
export async function recordDeliveryEvent(
  entry: DeliveryLogEntry,
  options: DeliveryLogOptions,
): Promise<boolean> {
  try {
    await options.writer.put(buildLogItem(entry));
    return true;
  } catch (error) {
    options.onError(error, { deliveryId: entry.deliveryId, event: entry.event });
    return false;
  }
}

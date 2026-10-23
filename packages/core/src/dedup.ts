import { createHash } from 'node:crypto';

export const IMMEDIATE_PERIOD = 'immediate';
export const DIGEST_CATEGORY = 'digest';
export const DIGEST_ENTITY = 'daily';
export const DEFAULT_SEGMENTS = 16;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface DedupParts {
  userId: string;
  category: string;
  entityId: string;
  /** `immediate`, or the user's local date (YYYY-MM-DD) for a digest. */
  period: string;
}

/** deliveryId = sha256(userId|category|entityId|period). Same notification -> same key, always. */
export function dedupKey(parts: DedupParts): string {
  const values = [parts.userId, parts.category, parts.entityId, parts.period];
  for (const value of values) {
    if (value.length === 0 || value.includes('|')) {
      throw new Error('dedup key parts must be non-empty and must not contain "|"');
    }
  }
  return sha256Hex(values.join('|'));
}

export function immediateDeliveryId(userId: string, category: string, entityId: string): string {
  return dedupKey({ userId, category, entityId, period: IMMEDIATE_PERIOD });
}

export interface DigestPart {
  /** 1-based. */
  index: number;
  total: number;
}

/**
 * period = the local date, or `<local date>#p<n>` when one day's digest had to be split into parts
 * to fit the message limits (each part is its own delivery).
 */
export function digestDeliveryId(userId: string, localDate: string, part?: DigestPart): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new Error('localDate must be YYYY-MM-DD');
  if (part && (!Number.isInteger(part.index) || part.index < 1 || part.index > part.total)) {
    throw new Error('digest part index must be within 1..total');
  }
  const period = part && part.total > 1 ? `${localDate}#p${String(part.index)}` : localDate;
  return dedupKey({ userId, category: DIGEST_CATEGORY, entityId: DIGEST_ENTITY, period });
}

/** Key for the suppressions table: sha256 of the trimmed, lower-cased address. */
export function emailHash(address: string): string {
  return sha256Hex(address.trim().toLowerCase());
}

/** Stable across runtimes and deploys: derived from sha256, never from process-local state. */
export function stableSegment(userId: string, segments: number = DEFAULT_SEGMENTS): number {
  if (!Number.isInteger(segments) || segments < 1) throw new Error('segments must be >= 1');
  return Number.parseInt(sha256Hex(userId).slice(0, 8), 16) % segments;
}

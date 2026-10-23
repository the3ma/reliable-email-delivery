import { randomUUID } from 'node:crypto';
import type { Category } from '@mail/core';
import { userId } from './seed-data.js';

/** Small deterministic PRNG so a given --seed always produces the same traffic. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Kind = 'valid' | 'duplicate' | 'invalid';

export interface GeneratedRequest {
  kind: Kind;
  /** What the product would put in the EventBridge `detail`. Invalid ones are deliberately broken. */
  detail: Record<string, unknown>;
}

const WEIGHTED: readonly Category[] = [
  'report_ready',
  'report_ready',
  'report_ready',
  'invoice_failed',
  'comment_added',
  'comment_added',
  'usage_alert',
];

function dataFor(category: Category, n: number): Record<string, string | number> {
  switch (category) {
    case 'report_ready':
      // Every 7th name carries markup: it must arrive escaped, not blocked.
      return {
        reportName: n % 7 === 0 ? `<b>Q${(n % 4) + 1}</b> costs & "usage"` : `Usage report ${n}`,
      };
    case 'invoice_failed':
      return { invoiceNumber: `INV-${10_000 + n}`, amount: ((n % 9) + 1) * 10, currency: 'EUR' };
    case 'comment_added':
      return { subject: `Document ${n}` };
    case 'usage_alert':
      return { metric: `API calls at ${80 + (n % 20)}% of plan` };
  }
}

const INVALID_VARIANTS: readonly ((base: Record<string, unknown>) => Record<string, unknown>)[] = [
  (base) => {
    const copy = { ...base };
    delete copy.userId;
    return copy;
  },
  (base) => ({ ...base, category: 'newsletter' }),
  (base) => ({ ...base, category: 'report_ready', data: {} }),
  (base) => ({ ...base, occurredAt: 'yesterday' }),
  (base) => ({ ...base, entityId: 'rep|injected' }),
];

export interface GenerateOptions {
  count: number;
  users: number;
  seed: number;
  duplicateRate?: number;
  invalidRate?: number;
  now?: Date;
}

export function generateRequests(options: GenerateOptions): GeneratedRequest[] {
  const random = mulberry32(options.seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
  const duplicateRate = options.duplicateRate ?? 0.1;
  const invalidRate = options.invalidRate ?? 0.03;
  const now = options.now ?? new Date();
  const out: GeneratedRequest[] = [];
  const valid: Record<string, unknown>[] = [];

  for (let n = 0; n < options.count; n += 1) {
    const roll = random();
    const previous = valid.length > 0 ? pick(valid) : undefined;
    if (previous && roll < duplicateRate) {
      // Half are exact redeliveries (same requestId), half are a producer re-emitting the same
      // event with a new requestId. Both must end in one e-mail.
      const detail = roll < duplicateRate / 2 ? previous : { ...previous, requestId: randomUUID() };
      out.push({ kind: 'duplicate', detail });
      continue;
    }
    const category = pick(WEIGHTED);
    const base: Record<string, unknown> = {
      requestId: randomUUID(),
      userId: userId(1 + Math.floor(random() * options.users)),
      category,
      entityId: `${category.split('_')[0] ?? 'e'}-${n}`,
      occurredAt: new Date(now.getTime() - Math.floor(random() * 3_600_000)).toISOString(),
      data: dataFor(category, n),
    };
    if (roll > 1 - invalidRate) {
      out.push({ kind: 'invalid', detail: pick(INVALID_VARIANTS)(base) });
      continue;
    }
    valid.push(base);
    out.push({ kind: 'valid', detail: base });
  }
  return out;
}

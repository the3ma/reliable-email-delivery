import { describe, expect, it } from 'vitest';
import {
  dedupKey,
  digestDeliveryId,
  emailHash,
  immediateDeliveryId,
  sha256Hex,
  stableSegment,
} from '../src/index.js';

describe('dedupKey', () => {
  it('is sha256(userId|category|entityId|period) in hex', () => {
    expect(
      dedupKey({ userId: 'u-1', category: 'report_ready', entityId: 'rep-7', period: 'immediate' }),
    ).toBe(sha256Hex('u-1|report_ready|rep-7|immediate'));
  });

  it('is deterministic across calls and independent of object key order', () => {
    const a = dedupKey({ userId: 'u-1', category: 'c', entityId: 'e', period: 'p' });
    const b = dedupKey({ period: 'p', entityId: 'e', category: 'c', userId: 'u-1' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any part changes', () => {
    const base = { userId: 'u-1', category: 'c', entityId: 'e', period: 'p' };
    const keys = new Set([
      dedupKey(base),
      dedupKey({ ...base, userId: 'u-2' }),
      dedupKey({ ...base, category: 'd' }),
      dedupKey({ ...base, entityId: 'f' }),
      dedupKey({ ...base, period: 'q' }),
    ]);
    expect(keys.size).toBe(5);
  });

  it('rejects the separator inside a part so two inputs cannot collide', () => {
    expect(() =>
      dedupKey({ userId: 'u-1', category: 'c|x', entityId: 'e', period: 'p' }),
    ).toThrow();
    expect(() => dedupKey({ userId: '', category: 'c', entityId: 'e', period: 'p' })).toThrow();
  });

  it('immediate and digest keys use their periods', () => {
    expect(immediateDeliveryId('u-1', 'report_ready', 'rep-7')).toBe(
      sha256Hex('u-1|report_ready|rep-7|immediate'),
    );
    expect(digestDeliveryId('u-1', '2026-10-23')).toBe(sha256Hex('u-1|digest|daily|2026-10-23'));
    expect(digestDeliveryId('u-1', '2026-10-23')).not.toBe(digestDeliveryId('u-1', '2026-10-24'));
    expect(() => digestDeliveryId('u-1', '23.10.2026')).toThrow();
  });
});

describe('digest parts', () => {
  it('a split digest uses <local date>#p<n>; a single digest keeps the plain date', () => {
    expect(digestDeliveryId('u-1', '2026-10-23', { index: 2, total: 3 })).toBe(
      sha256Hex('u-1|digest|daily|2026-10-23#p2'),
    );
    expect(digestDeliveryId('u-1', '2026-10-23', { index: 1, total: 1 })).toBe(
      digestDeliveryId('u-1', '2026-10-23'),
    );
    // The id of part n does not depend on how many parts there are.
    expect(digestDeliveryId('u-1', '2026-10-23', { index: 1, total: 2 })).toBe(
      digestDeliveryId('u-1', '2026-10-23', { index: 1, total: 5 }),
    );
    expect(() => digestDeliveryId('u-1', '2026-10-23', { index: 0, total: 2 })).toThrow();
    expect(() => digestDeliveryId('u-1', '2026-10-23', { index: 3, total: 2 })).toThrow();
  });
});

describe('emailHash', () => {
  it('normalises case and surrounding whitespace', () => {
    expect(emailHash(' Ada@Example.TEST ')).toBe(emailHash('ada@example.test'));
    expect(emailHash('ada@example.test')).toBe(sha256Hex('ada@example.test'));
  });
});

describe('stableSegment', () => {
  it('is stable (golden values) and within range', () => {
    const first = stableSegment('u-123');
    expect(stableSegment('u-123')).toBe(first);
    expect(first).toBe(Number.parseInt(sha256Hex('u-123').slice(0, 8), 16) % 16);
    for (let i = 0; i < 500; i += 1) {
      const segment = stableSegment(`u-${i}`);
      expect(segment).toBeGreaterThanOrEqual(0);
      expect(segment).toBeLessThan(16);
    }
  });

  it('spreads users over all segments', () => {
    const seen = new Set(Array.from({ length: 500 }, (_, i) => stableSegment(`u-${i}`)));
    expect(seen.size).toBe(16);
  });

  it('rejects a non-positive segment count', () => {
    expect(() => stableSegment('u-1', 0)).toThrow();
  });
});

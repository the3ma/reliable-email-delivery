import { describe, expect, it, vi } from 'vitest';
import {
  ITEM_BUDGET_BYTES,
  buildLogItem,
  jsonBytes,
  recordDeliveryEvent,
  truncateUtf8,
} from '../src/index.js';
import type { DeliveryLogEntry } from '../src/index.js';
import { InMemoryDeliveryLog } from '../src/testing/index.js';

const AT = new Date('2026-10-23T08:00:00.000Z');

function entry(details: Record<string, unknown>): DeliveryLogEntry {
  return { deliveryId: 'd'.repeat(64), event: 'failed', at: AT, details };
}

describe('truncateUtf8', () => {
  it('returns short strings unchanged', () => {
    expect(truncateUtf8('hello', 10)).toBe('hello');
  });

  it('never splits a multibyte character', () => {
    // 'é' is 2 bytes, '€' is 3, the emoji is 4 (a surrogate pair in UTF-16).
    const value = 'é€😀'.repeat(200);
    for (let limit = 14; limit < 80; limit += 1) {
      const out = truncateUtf8(value, limit);
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(limit);
      expect(out).not.toContain('�');
      // Round-tripping through UTF-8 must be lossless: no lone surrogate was produced.
      expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
      expect(out.endsWith('...[truncated]')).toBe(true);
    }
  });

  it('cuts exactly at the boundary before a 4-byte character', () => {
    const marker = '...[truncated]';
    const value = `ab😀${'c'.repeat(100)}`;
    // Room for 'ab' plus 3 bytes: the emoji (4 bytes) must not be split.
    expect(truncateUtf8(value, 2 + 3 + marker.length)).toBe(`ab${marker}`);
    expect(truncateUtf8(value, 2 + 4 + marker.length)).toBe(`ab😀${marker}`);
  });
});

describe('buildLogItem', () => {
  it('keeps small details untouched (stage 0)', () => {
    const item = buildLogItem(entry({ reason: 'MessageRejected' }));
    expect(item).toMatchObject({
      deliveryId: 'd'.repeat(64),
      sk: '2026-10-23T08:00:00.000Z#failed',
      event: 'failed',
      details: { reason: 'MessageRejected' },
      shedStage: 0,
    });
    expect(item.expiresAt).toBe(Math.floor(AT.getTime() / 1000) + 90 * 86_400);
  });

  it('redacts details: addresses masked, bodies omitted', () => {
    const item = buildLogItem(
      entry({
        to: 'ada@example.test',
        html: '<p>secret</p>',
        errorMessage: 'rejected <ada@example.test>',
      }),
    );
    expect(item.details).toEqual({
      to: 'a***@example.test',
      html: '[omitted: 13 chars]',
      errorMessage: 'rejected <a***@example.test>',
    });
  });

  it('sheds oversized details until the serialised item fits the 380 KB budget', () => {
    const huge = 'x'.repeat(500 * 1024);
    const item = buildLogItem(entry({ reason: 'r', trace: huge }));
    expect(jsonBytes(item)).toBeLessThanOrEqual(ITEM_BUDGET_BYTES);
    expect(item.shedStage).toBe(1);
    expect(item.details.reason).toBe('r');
  });

  it('drops non-essential keys when many medium fields still do not fit', () => {
    const details: Record<string, unknown> = { reason: 'kept', errorName: 'E' };
    for (let i = 0; i < 2000; i += 1) details[`field${i}`] = 'y'.repeat(600);
    const item = buildLogItem(entry(details));
    expect(jsonBytes(item)).toBeLessThanOrEqual(ITEM_BUDGET_BYTES);
    expect(item.shedStage).toBe(3);
    expect(item.details).toMatchObject({ reason: 'kept', errorName: 'E' });
    expect(item.details.droppedKeys).toBeDefined();
  });

  it('re-measures after JSON escaping (control characters grow 6x when serialised)', () => {
    // 70 K control chars are 70 KB raw but ~420 KB as JSON (\u0001 each).
    const control = '\u0001'.repeat(70 * 1024);
    expect(Buffer.byteLength(control, 'utf8')).toBeLessThan(ITEM_BUDGET_BYTES);
    const item = buildLogItem(entry({ reason: 'r', blob: control }));
    expect(jsonBytes(item)).toBeLessThanOrEqual(ITEM_BUDGET_BYTES);
    expect(item.shedStage).toBeGreaterThan(0);
  });

  it('multibyte payloads are measured in bytes, not characters', () => {
    const emoji = '😀'.repeat(120 * 1024); // 120 K chars x 4 bytes = 480 KB
    const item = buildLogItem(entry({ reason: 'r', note: emoji }));
    expect(jsonBytes(item)).toBeLessThanOrEqual(ITEM_BUDGET_BYTES);
    expect(Buffer.from(String(item.details.note), 'utf8').toString('utf8')).toBe(item.details.note);
  });

  it('final stage keeps only a marker and the original size', () => {
    const item = buildLogItem(entry({ reason: 'x'.repeat(1000) }), 400);
    expect(item.details).toMatchObject({ shed: 'all' });
    expect(jsonBytes(item)).toBeLessThanOrEqual(400);
  });

  it('does not mutate the input', () => {
    const details = {
      to: 'ada@example.test',
      nested: { text: 'body' },
      big: 'z'.repeat(400 * 1024),
    };
    const snapshot = structuredClone(details);
    const input = entry(details);
    buildLogItem(input);
    expect(details).toEqual(snapshot);
    expect(input.details).toBe(details);
  });
});

describe('recordDeliveryEvent', () => {
  it('never throws; reports the error instead', async () => {
    const writer = new InMemoryDeliveryLog();
    writer.failWith = new Error(
      'ValidationException: Item size has exceeded the maximum allowed size',
    );
    const onError = vi.fn();
    await expect(recordDeliveryEvent(entry({}), { writer, onError })).resolves.toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('writes the built item', async () => {
    const writer = new InMemoryDeliveryLog();
    await expect(
      recordDeliveryEvent(entry({ reason: 'r' }), { writer, onError: vi.fn() }),
    ).resolves.toBe(true);
    expect(writer.events()).toEqual(['failed']);
  });
});

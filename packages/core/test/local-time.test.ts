import { describe, expect, it } from 'vitest';
import { digestDue, isValidTimeZone, localParts, parseDigestWindow } from '../src/index.js';

const WINDOW = { startHour: 6, endHour: 10 };

describe('localParts', () => {
  it('converts to the wall clock of the zone', () => {
    expect(localParts(new Date('2026-10-23T05:30:00Z'), 'Asia/Tokyo')).toEqual({
      date: '2026-10-23',
      hour: 14,
      minute: 30,
    });
    expect(localParts(new Date('2026-10-23T05:30:00Z'), 'America/Los_Angeles')).toEqual({
      date: '2026-10-22',
      hour: 22,
      minute: 30,
    });
  });

  it('uses 00-23 hours (midnight is 0, not 24)', () => {
    expect(localParts(new Date('2026-10-23T00:00:00Z'), 'UTC').hour).toBe(0);
  });
});

describe('digestDue', () => {
  it('the same instant is morning in one zone and night in another', () => {
    const instant = new Date('2026-10-23T07:00:00Z');
    expect(digestDue(instant, 'Europe/London', WINDOW)).toEqual({
      due: true,
      localDate: '2026-10-23',
    }); // 08:00 BST
    expect(digestDue(instant, 'America/New_York', WINDOW)).toEqual({
      due: false,
      localDate: '2026-10-23',
    }); // 03:00
    expect(digestDue(instant, 'Asia/Tokyo', WINDOW).due).toBe(false); // 16:00
  });

  it('the period is the LOCAL date, which can differ from the UTC date', () => {
    // 19:30 UTC on the 22nd is 08:30 on the 23rd in Auckland (NZDT, UTC+13).
    expect(digestDue(new Date('2026-10-22T19:30:00Z'), 'Pacific/Auckland', WINDOW)).toEqual({
      due: true,
      localDate: '2026-10-23',
    });
  });

  it('window bounds: start inclusive, end exclusive', () => {
    expect(digestDue(new Date('2026-01-15T06:00:00Z'), 'UTC', WINDOW).due).toBe(true);
    expect(digestDue(new Date('2026-01-15T05:59:00Z'), 'UTC', WINDOW).due).toBe(false);
    expect(digestDue(new Date('2026-01-15T09:59:00Z'), 'UTC', WINDOW).due).toBe(true);
    expect(digestDue(new Date('2026-01-15T10:00:00Z'), 'UTC', WINDOW).due).toBe(false);
  });

  it('follows DST in New York (spring forward 2026-03-08)', () => {
    // 11:30 UTC: 06:30 EST the day before the switch, 07:30 EDT the day after.
    expect(localParts(new Date('2026-03-07T11:30:00Z'), 'America/New_York').hour).toBe(6);
    expect(localParts(new Date('2026-03-09T11:30:00Z'), 'America/New_York').hour).toBe(7);
    // 10:30 UTC: 05:30 EST (not due) before, 06:30 EDT (due) after.
    expect(digestDue(new Date('2026-03-07T10:30:00Z'), 'America/New_York', WINDOW).due).toBe(false);
    expect(digestDue(new Date('2026-03-09T10:30:00Z'), 'America/New_York', WINDOW).due).toBe(true);
  });

  it('follows DST in London (fall back 2026-10-25)', () => {
    // 09:30 UTC: 10:30 BST (not due) before, 09:30 GMT (due) after.
    expect(digestDue(new Date('2026-10-24T09:30:00Z'), 'Europe/London', WINDOW).due).toBe(false);
    expect(digestDue(new Date('2026-10-26T09:30:00Z'), 'Europe/London', WINDOW).due).toBe(true);
  });

  it('southern hemisphere DST (Sydney, AEDT from 2026-10-04)', () => {
    // 20:00 UTC: 06:00 AEST before the switch, 07:00 AEDT after.
    expect(localParts(new Date('2026-10-02T20:00:00Z'), 'Australia/Sydney')).toMatchObject({
      hour: 6,
      date: '2026-10-03',
    });
    expect(localParts(new Date('2026-10-05T20:00:00Z'), 'Australia/Sydney')).toMatchObject({
      hour: 7,
      date: '2026-10-06',
    });
  });

  it('a whole-day window covers every hour', () => {
    expect(
      digestDue(new Date('2026-10-23T23:59:00Z'), 'UTC', { startHour: 0, endHour: 24 }).due,
    ).toBe(true);
  });
});

describe('time zone and window parsing', () => {
  it('validates IANA zones', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });

  it('parses and validates the window', () => {
    expect(parseDigestWindow(undefined, undefined)).toEqual({ startHour: 6, endHour: 10 });
    expect(parseDigestWindow('7', '9')).toEqual({ startHour: 7, endHour: 9 });
    expect(() => parseDigestWindow('9', '7')).toThrow();
    expect(() => parseDigestWindow('-1', '7')).toThrow();
    expect(() => parseDigestWindow('6.5', '9')).toThrow();
    expect(() => parseDigestWindow('6', '25')).toThrow();
  });
});

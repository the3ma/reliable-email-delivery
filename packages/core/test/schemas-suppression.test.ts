import { describe, expect, it } from 'vitest';
import {
  EmailMessageSchema,
  LIMITS,
  NotificationRequestSchema,
  checkSuppression,
  describeIssues,
  emailHash,
  messageLimitViolation,
} from '../src/index.js';
import type { EmailMessage } from '../src/index.js';
import { InMemoryAccountSuppressionList, InMemorySuppressions } from '../src/testing/index.js';

const REQUEST = {
  requestId: '6f1c2a40-3b7e-4c1d-9a8e-2f4b5c6d7e8f',
  userId: 'u-123',
  category: 'report_ready',
  entityId: 'rep-77',
  occurredAt: '2026-10-23T08:15:00Z',
  data: { reportName: 'Q3 usage' },
};

const MESSAGE: EmailMessage = {
  deliveryId: 'e'.repeat(64),
  userId: 'u-123',
  to: 'ada@example.test',
  templateId: 'report_ready',
  subject: 'Subject',
  text: 'Text',
  html: '<p>Html</p>',
  category: 'report_ready',
  kind: 'immediate',
  requestIds: [REQUEST.requestId],
  redact: false,
  createdAt: '2026-10-23T08:15:01Z',
};

describe('NotificationRequestSchema', () => {
  it('accepts the contract example', () => {
    expect(NotificationRequestSchema.parse(REQUEST)).toEqual(REQUEST);
  });

  it('defaults data to {}', () => {
    const rest: Partial<typeof REQUEST> = { ...REQUEST };
    delete rest.data;
    expect(NotificationRequestSchema.parse(rest).data).toEqual({});
  });

  it.each([
    ['unknown category', { category: 'newsletter' }],
    ['separator in entityId', { entityId: 'a|b' }],
    ['bad userId', { userId: 'u 1' }],
    ['bad timestamp', { occurredAt: 'yesterday' }],
    ['bad requestId', { requestId: '123' }],
    ['nested data', { data: { a: { b: 1 } } }],
  ])('rejects %s', (_label, patch) => {
    expect(NotificationRequestSchema.safeParse({ ...REQUEST, ...patch }).success).toBe(false);
  });

  it('describeIssues names the path but never echoes the value', () => {
    const result = EmailMessageSchema.safeParse({
      ...MESSAGE,
      to: 'not-an-address ada@example.test',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = describeIssues(result.error).join(' ');
      expect(issues).toContain('to:');
      expect(issues).not.toContain('example.test');
    }
  });
});

describe('messageLimitViolation (contract section 6 limits)', () => {
  const bytes = (m: EmailMessage) => Buffer.byteLength(JSON.stringify(m));

  it('accepts a normal message', () => {
    expect(messageLimitViolation(MESSAGE, bytes(MESSAGE))).toBeUndefined();
  });

  it('subject over 998 chars', () => {
    const m = { ...MESSAGE, subject: 's'.repeat(LIMITS.subjectChars + 1) };
    expect(messageLimitViolation(m, bytes(m))).toBe('subject_too_long');
  });

  it('subject with a line break', () => {
    const m = { ...MESSAGE, subject: 'a\nBcc: x' };
    expect(messageLimitViolation(m, bytes(m))).toBe('subject_has_line_break');
  });

  it('text and html over 256 KiB (bytes, not chars)', () => {
    const text = { ...MESSAGE, text: 'é'.repeat(LIMITS.bodyBytes / 2 + 1) };
    expect(messageLimitViolation(text, 0)).toBe('text_too_large');
    const html = { ...MESSAGE, html: 'x'.repeat(LIMITS.bodyBytes + 1) };
    expect(messageLimitViolation(html, 0)).toBe('html_too_large');
  });

  it('whole message over 1 MiB', () => {
    expect(messageLimitViolation(MESSAGE, LIMITS.messageBytes + 1)).toBe('message_too_large');
  });
});

describe('checkSuppression', () => {
  it('table hit (by hash, case-insensitive)', async () => {
    const store = new InMemorySuppressions();
    await store.upsert({
      emailHash: emailHash('ada@example.test'),
      reason: 'complaint',
      source: 's',
      at: new Date(),
    });
    expect(await checkSuppression('ADA@example.test', { store })).toEqual({
      suppressed: true,
      source: 'table',
      reason: 'complaint',
    });
  });

  it('SES account list hit', async () => {
    const store = new InMemorySuppressions();
    const accountList = new InMemoryAccountSuppressionList(new Set(['bob@example.test']));
    expect(await checkSuppression('bob@example.test', { store, accountList })).toEqual({
      suppressed: true,
      source: 'account',
    });
    expect(await checkSuppression('carol@example.test', { store, accountList })).toEqual({
      suppressed: false,
    });
  });

  it('lookup errors propagate (never "assume not suppressed")', async () => {
    const store = new InMemorySuppressions();
    store.failWith = new Error('dynamo down');
    await expect(checkSuppression('ada@example.test', { store })).rejects.toThrow('dynamo down');
  });
});

import { describe, expect, it } from 'vitest';
import {
  containsAddress,
  describeError,
  emailHash,
  hashEmail,
  maskEmail,
  omitBody,
  redact,
  scrubAddresses,
} from '../src/index.js';
import { awsError } from '../src/testing/index.js';

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('ada@example.test')).toBe('a***@example.test');
    expect(maskEmail('x@example.test')).toBe('x***@example.test');
  });

  it('is idempotent and safe on garbage', () => {
    expect(maskEmail(maskEmail('ada@example.test'))).toBe('a***@example.test');
    expect(maskEmail('not-an-address')).toBe('***');
    expect(maskEmail('@example.test')).toBe('***');
  });
});

describe('scrubAddresses', () => {
  it('masks every address embedded in free text', () => {
    const text =
      'Message rejected: Email address is not verified. <ada@example.test>, bob.smith+tag@mail.example.test';
    expect(scrubAddresses(text)).toBe(
      'Message rejected: Email address is not verified. <a***@example.test>, b***@mail.example.test',
    );
  });

  it('leaves text without addresses alone', () => {
    expect(scrubAddresses('Throttling: rate exceeded')).toBe('Throttling: rate exceeded');
  });

  it('containsAddress ignores already-masked addresses', () => {
    expect(containsAddress('to a***@example.test')).toBe(false);
    expect(containsAddress('to ada@example.test')).toBe(true);
  });
});

describe('redact', () => {
  it('omits bodies, masks address fields and scrubs strings, deeply, without mutating', () => {
    const input = {
      to: 'ada@example.test',
      subject: 'Report for ada@example.test',
      text: 'Hello Ada, your secret report',
      html: '<p>Hello</p>',
      nested: { email: 'bob@example.test', list: ['carol@example.test', 3] },
    };
    const copy = structuredClone(input);
    expect(redact(input)).toEqual({
      to: 'a***@example.test',
      subject: 'Report for a***@example.test',
      text: '[omitted: 29 chars]',
      html: '[omitted: 12 chars]',
      nested: { email: 'b***@example.test', list: ['c***@example.test', 3] },
    });
    expect(input).toEqual(copy);
  });

  it('turns errors into scrubbed summaries', () => {
    expect(
      redact({ error: awsError('MessageRejected', 400, 'bad recipient ada@example.test') }),
    ).toEqual({
      error: {
        errorName: 'MessageRejected',
        errorMessage: 'bad recipient a***@example.test',
        httpStatus: 400,
      },
    });
  });

  it('stops at a depth limit instead of recursing forever', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 20; i += 1) deep = { deep };
    expect(JSON.stringify(redact(deep))).toContain('[omitted: depth]');
  });
});

describe('helpers', () => {
  it('omitBody reports only the length', () => {
    expect(omitBody('abc')).toBe('[omitted: 3 chars]');
  });

  it('hashEmail is the suppression key', () => {
    expect(hashEmail('Ada@Example.test')).toBe(emailHash('ada@example.test'));
  });

  it('describeError handles non-errors and codes', () => {
    expect(describeError('boom ada@example.test')).toEqual({
      errorName: 'NonError',
      errorMessage: 'boom a***@example.test',
    });
    expect(describeError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toMatchObject({
      code: 'ECONNRESET',
    });
  });
});

describe('scrubAddresses performance', () => {
  it('is linear on large payloads (no regex backtracking)', () => {
    const big = `${'x'.repeat(1024 * 1024)}@${'y'.repeat(1024 * 1024)}`;
    const started = performance.now();
    scrubAddresses(big);
    scrubAddresses('a@'.repeat(200_000));
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

import { describe, expect, it } from 'vitest';
import { classifySendError } from '../src/index.js';
import { awsError } from '../src/testing/index.js';

function withCode(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(code), { code, ...extra });
}

describe('classifySendError', () => {
  it.each([
    ['MessageRejected', 400],
    ['MailFromDomainNotVerifiedException', 400],
    ['AccountSuspendedException', 400],
    ['BadRequestException', 400],
    ['NotFoundException', 404],
  ])('%s is permanent', (name, status) => {
    expect(classifySendError(awsError(name, status))).toBe('permanent');
  });

  it.each([
    ['TooManyRequestsException', 429],
    ['ThrottlingException', 400],
    ['LimitExceededException', 400],
    ['SendingPausedException', 400],
    ['InternalFailure', 500],
    ['ServiceUnavailable', 503],
  ])('%s is transient', (name, status) => {
    expect(classifySendError(awsError(name, status))).toBe('transient');
  });

  it('falls back to the HTTP status for unknown names', () => {
    expect(classifySendError(awsError('SomethingNew', 503))).toBe('transient');
    expect(classifySendError(awsError('SomethingNew', 429))).toBe('transient');
    expect(classifySendError(awsError('SomethingNew', 422))).toBe('permanent');
  });

  it('connection failures before sending are transient', () => {
    expect(classifySendError(withCode('ECONNREFUSED'))).toBe('transient');
    expect(classifySendError(withCode('ENOTFOUND'))).toBe('transient');
    expect(classifySendError(withCode('ETIMEDOUT'))).toBe('transient');
    expect(classifySendError(new Error('no idea'))).toBe('transient');
    expect(classifySendError('a string')).toBe('transient');
  });

  it('a lost response (possibly accepted) is unknown, never retried blindly', () => {
    const timeout = new Error('Request timed out');
    timeout.name = 'TimeoutError';
    expect(classifySendError(timeout)).toBe('unknown');
    expect(classifySendError(withCode('ECONNRESET'))).toBe('unknown');
    expect(classifySendError(withCode('EPIPE'))).toBe('unknown');
  });

  it('SMTP reply codes: 5xx permanent, 4xx transient', () => {
    expect(classifySendError(withCode('EENVELOPE', { responseCode: 550 }))).toBe('permanent');
    expect(classifySendError(withCode('EENVELOPE', { responseCode: 451 }))).toBe('transient');
  });
});

/**
 * - transient: the provider answered "not now" (throttling, 5xx) or was never reached -> retry.
 * - permanent: retrying cannot help -> FAILED_PERMANENT.
 * - unknown: the request may have been accepted but no answer came back (client timeout,
 *   connection reset mid-request). A retry could send twice, so it is handled as AMBIGUOUS.
 */
export type SendErrorClass = 'transient' | 'permanent' | 'unknown';

/** Retrying cannot help: the message, identity or account is the problem. */
const PERMANENT_NAMES = new Set([
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'AccountSuspendedException',
  'BadRequestException',
  'NotFoundException',
  'InvalidParameterValue',
  'ValidationException',
  'MessageTooLarge',
]);

/** Retrying later can help. SendingPaused is reversible by an operator, so it must not fail mail. */
const TRANSIENT_NAMES = new Set([
  'TooManyRequestsException',
  'ThrottlingException',
  'Throttling',
  'LimitExceededException',
  'SendingPausedException',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'InternalFailure',
  'InternalServiceError',
  'RequestTimeout',
  'RequestTimeoutException',
]);

/** Client-side: the request was (possibly) written but the response never arrived. */
const UNKNOWN_OUTCOME_NAMES = new Set(['TimeoutError', 'AbortError']);
const UNKNOWN_OUTCOME_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);

/** Failed before anything was sent: connection refused, DNS, connect/greeting timeouts. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNECTION',
  'ESOCKET',
  'EDNS',
]);

function numberField(error: object, path: readonly string[]): number | undefined {
  let current: unknown = error;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'number' ? current : undefined;
}

/**
 * Classifies SES v2 SDK errors (by name, then HTTP status) and SMTP errors (by reply code).
 * Anything else is a network failure before sending, i.e. transient.
 */
export function classifySendError(error: unknown): SendErrorClass {
  if (error === null || typeof error !== 'object') return 'transient';
  const name = (error as { name?: unknown }).name;
  if (typeof name === 'string') {
    if (PERMANENT_NAMES.has(name)) return 'permanent';
    if (TRANSIENT_NAMES.has(name)) return 'transient';
    if (UNKNOWN_OUTCOME_NAMES.has(name)) return 'unknown';
  }

  const status = numberField(error, ['$metadata', 'httpStatusCode']);
  if (status !== undefined) {
    if (status === 429 || status >= 500) return 'transient';
    if (status >= 400) return 'permanent';
  }

  // nodemailer: responseCode is the SMTP reply (4xx temporary, 5xx permanent).
  const smtp = numberField(error, ['responseCode']);
  if (smtp !== undefined) {
    if (smtp >= 500) return 'permanent';
    if (smtp >= 400) return 'transient';
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (UNKNOWN_OUTCOME_CODES.has(code)) return 'unknown';
    if (TRANSIENT_NETWORK_CODES.has(code)) return 'transient';
  }
  return 'transient';
}

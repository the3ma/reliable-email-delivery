import { emailHash } from './dedup.js';

// Deliberately broad (RFC 5322 local-part characters): over-masking is cheap, a leak is not.
const LOCAL_CHAR = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]/;
const DOMAIN_CHAR = /[A-Za-z0-9.-]/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const MAX_LOCAL = 64;
const MAX_DOMAIN = 255;

function isDomain(value: string): boolean {
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((label) => LABEL.test(label));
}

/** `ada@example.test` -> `a***@example.test`. Idempotent. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${address.charAt(0)}***${address.slice(at)}`;
}

/** Use wherever an address would be a key or a join field (tables, metrics, log correlation). */
export function hashEmail(address: string): string {
  return emailHash(address);
}

/**
 * Expands outwards from each '@' with bounded scans instead of one global regex: a regex with a
 * leading `[...]+` backtracks quadratically on large '@'-free payloads, and this runs on every
 * log line and every delivery-log item.
 */
export function scrubAddresses(text: string): string {
  let at = text.indexOf('@');
  if (at === -1) return text;
  let out = '';
  let last = 0;
  while (at !== -1) {
    let start = at;
    while (start > last && at - start < MAX_LOCAL && LOCAL_CHAR.test(text.charAt(start - 1))) {
      start -= 1;
    }
    let end = at + 1;
    while (end < text.length && end - at <= MAX_DOMAIN && DOMAIN_CHAR.test(text.charAt(end))) {
      end += 1;
    }
    while (end > at + 1 && /[.-]/.test(text.charAt(end - 1))) end -= 1;
    if (start < at && isDomain(text.slice(at + 1, end))) {
      out += text.slice(last, start) + maskEmail(text.slice(start, end));
      last = end;
    }
    at = text.indexOf('@', Math.max(at + 1, last));
  }
  return out + text.slice(last);
}

/** True when `text` holds an address that is not already masked. */
export function containsAddress(text: string): boolean {
  return scrubAddresses(text) !== text;
}

export function omitBody(body: string): string {
  return `[omitted: ${body.length} chars]`;
}

const BODY_KEYS = new Set(['text', 'html', 'body', 'content']);
const ADDRESS_KEYS = new Set(['to', 'email', 'address', 'recipient', 'from', 'cc', 'bcc']);

/**
 * Returns a deep copy that is safe to log: bodies omitted, address fields masked, and any address
 * embedded in free text (error messages, subjects) masked. Never mutates the input.
 */
export function redact(value: unknown, key?: string, depth = 0): unknown {
  if (depth > 8) return '[omitted: depth]';
  if (typeof value === 'string') {
    if (key !== undefined && BODY_KEYS.has(key)) return omitBody(value);
    if (key !== undefined && ADDRESS_KEYS.has(key)) return maskEmail(value);
    return scrubAddresses(value);
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, key, depth + 1));
  if (value instanceof Error) return describeError(value);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [entryKey, entry] of Object.entries(value)) {
      out[entryKey] = redact(entry, entryKey, depth + 1);
    }
    return out;
  }
  return value;
}

export interface ErrorSummary {
  errorName: string;
  errorMessage: string;
  httpStatus?: number;
  code?: string;
}

const MAX_ERROR_MESSAGE = 1000;

/** SES and SMTP errors echo the recipient back; never log `error.message` without this. */
export function describeError(error: unknown): ErrorSummary {
  if (!(error instanceof Error)) {
    return { errorName: 'NonError', errorMessage: scrubAddresses(String(error)).slice(0, 200) };
  }
  const summary: ErrorSummary = {
    errorName: error.name,
    errorMessage: scrubAddresses(error.message).slice(0, MAX_ERROR_MESSAGE),
  };
  const meta = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  if (typeof meta?.httpStatusCode === 'number') summary.httpStatus = meta.httpStatusCode;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') summary.code = code;
  return summary;
}

import type { DeliveryStatus } from '../api/types';

const dateTime = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const time = new Intl.DateTimeFormat('en', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const shortDateTime = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const number = new Intl.NumberFormat('en');

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
}

/** Compact form for dense tables, e.g. `Oct 23, 17:47`; pair it with the full value in a title. */
export function formatShortDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : shortDateTime.format(date);
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : time.format(date);
}

export function formatNumber(value: number): string {
  return number.format(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** First and last characters of a long hex id, e.g. `3f9a1c…e07b`. */
export function shortId(id: string, head = 8, tail = 4): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export const STATUS_LABELS: Readonly<Record<DeliveryStatus, string>> = {
  SENT: 'Sent',
  SKIPPED: 'Skipped',
  RELEASED: 'Released',
  CLAIMED: 'Claimed',
  FAILED_PERMANENT: 'Failed (permanent)',
  AMBIGUOUS: 'Ambiguous',
};

export const STATUS_HINTS: Readonly<Record<DeliveryStatus, string>> = {
  SENT: 'accepted by the mail transport',
  SKIPPED: 'deliberately not sent (suppressed, disabled, invalid)',
  RELEASED: 'transient error; will be claimed again',
  CLAIMED: 'a worker holds the lease and is sending',
  FAILED_PERMANENT: 'rejected; never retried',
  AMBIGUOUS: 'lease expired mid-send; never resent automatically',
};

export function humanize(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  const spaced = value.replace(/:/g, ': ').replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function recipients(to: string | string[]): string {
  return Array.isArray(to) ? to.join(', ') : to;
}

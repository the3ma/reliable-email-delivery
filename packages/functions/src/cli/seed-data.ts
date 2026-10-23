import { CATEGORIES, stableSegment } from '@mail/core';
import type { Category, Subscription } from '@mail/core';

export const TIMEZONES = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Helsinki',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Asia/Kolkata',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
] as const;

/** Preference profiles, cycled across users. */
const PROFILES: readonly { immediate: Category[]; digest: Category[] }[] = [
  { immediate: ['report_ready', 'invoice_failed'], digest: ['comment_added', 'usage_alert'] },
  { immediate: ['invoice_failed'], digest: ['report_ready', 'comment_added', 'usage_alert'] },
  { immediate: [], digest: [...CATEGORIES] },
  // comment_added has no immediate template, so it falls back to the digest.
  { immediate: [...CATEGORIES], digest: [] },
  { immediate: ['report_ready'], digest: [] },
];

export function userId(index: number): string {
  return `u-${String(index).padStart(3, '0')}`;
}

export function seedSubscription(index: number, segments: number): Subscription {
  const id = userId(index);
  const profile = PROFILES[index % PROFILES.length] ?? { immediate: [], digest: [] };
  return {
    userId: id,
    email: `user-${String(index).padStart(3, '0')}@example.test`,
    timezone: TIMEZONES[index % TIMEZONES.length] ?? 'UTC',
    locale: 'en',
    immediate: profile.immediate,
    digest: profile.digest,
    segment: stableSegment(id, segments),
  };
}

import digestHtml from '../../../../templates/digest.html';
import digestSubject from '../../../../templates/digest.subject.txt';
import digestText from '../../../../templates/digest.text.txt';
import invoiceFailedHtml from '../../../../templates/invoice_failed.html';
import invoiceFailedSubject from '../../../../templates/invoice_failed.subject.txt';
import invoiceFailedText from '../../../../templates/invoice_failed.text.txt';
import reportReadyHtml from '../../../../templates/report_ready.html';
import reportReadySubject from '../../../../templates/report_ready.subject.txt';
import reportReadyText from '../../../../templates/report_ready.text.txt';
import type { Category, DataValue, ImmediateTemplateId, NotificationRequest, TemplateId } from '../schemas.js';
import { renderEmail } from './renderer.js';
import type { RenderedEmail, TemplateSource } from './renderer.js';

export const TEMPLATES: Readonly<Record<TemplateId, TemplateSource>> = {
  report_ready: { subject: reportReadySubject, text: reportReadyText, html: reportReadyHtml },
  invoice_failed: { subject: invoiceFailedSubject, text: invoiceFailedText, html: invoiceFailedHtml },
  digest: { subject: digestSubject, text: digestText, html: digestHtml },
};

/** Categories whose immediate e-mail is sensitive enough that the processor must not log the subject. */
const REDACTED_CATEGORIES = new Set<Category>(['invoice_failed']);

export function isRedactedCategory(category: Category): boolean {
  return REDACTED_CATEGORIES.has(category);
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

const ENTITY_PATHS: Readonly<Record<Category, string>> = {
  report_ready: '/reports/',
  invoice_failed: '/billing/invoices/',
  comment_added: '/comments/',
  usage_alert: '/usage/',
};

export function entityUrl(appBaseUrl: string, category: Category, entityId: string): string {
  return joinUrl(appBaseUrl, `${ENTITY_PATHS[category]}${encodeURIComponent(entityId)}`);
}

export function preferencesUrl(appBaseUrl: string): string {
  return joinUrl(appBaseUrl, '/settings/notifications');
}

/** Request data first, then derived fields (which win, so data cannot spoof a link). */
export function renderImmediate(
  templateId: ImmediateTemplateId,
  request: NotificationRequest,
  appBaseUrl: string,
): RenderedEmail {
  const view = {
    ...request.data,
    entityId: request.entityId,
    entityUrl: entityUrl(appBaseUrl, request.category, request.entityId),
    preferencesUrl: preferencesUrl(appBaseUrl),
    appUrl: appBaseUrl,
  };
  return renderEmail(TEMPLATES[templateId], view);
}

export interface DigestEntry {
  category: Category;
  entityId: string;
  occurredAt: string;
  data: Readonly<Record<string, DataValue>>;
}

const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  report_ready: 'Reports',
  invoice_failed: 'Billing',
  comment_added: 'Comments',
  usage_alert: 'Usage',
};

const CATEGORY_ORDER: readonly Category[] = ['invoice_failed', 'usage_alert', 'report_ready', 'comment_added'];

function text(data: Readonly<Record<string, DataValue>>, key: string, fallback: string): string {
  const value = data[key];
  return value === undefined ? fallback : String(value);
}

/** A digest item must never fail the whole digest, so titles fall back to the entity id. */
export function digestItemTitle(entry: DigestEntry): string {
  switch (entry.category) {
    case 'report_ready':
      return `Report "${text(entry.data, 'reportName', entry.entityId)}" is ready`;
    case 'invoice_failed':
      return `Payment failed for invoice ${text(entry.data, 'invoiceNumber', entry.entityId)}`;
    case 'comment_added':
      return `New comment on ${text(entry.data, 'subject', entry.entityId)}`;
    case 'usage_alert':
      return `Usage alert: ${text(entry.data, 'metric', entry.entityId)}`;
  }
}

export const MAX_DIGEST_ITEMS = 100;

export interface DigestView {
  localDate: string;
  total: number;
  plural: boolean;
  groups: { label: string; count: number; items: { title: string; url: string }[] }[];
  hasMore: boolean;
  moreCount: number;
  /** `false` for a single digest; set when one day's digest is split into parts. */
  part: false | { partIndex: number; partCount: number };
  appUrl: string;
  preferencesUrl: string;
}

/** Latest entry per (category, entityId), newest first. */
export function uniqueDigestEntries<T extends DigestEntry>(entries: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const entry of entries) {
    const key = `${entry.category}|${entry.entityId}`;
    const seen = latest.get(key);
    if (!seen || seen.occurredAt < entry.occurredAt) latest.set(key, entry);
  }
  return [...latest.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

/**
 * Groups by category (fixed order), newest first, de-duplicated by (category, entityId), and caps
 * the number of listed items (the rest is linked as "...and N more").
 */
export function buildDigestView(
  entries: readonly DigestEntry[],
  localDate: string,
  appBaseUrl: string,
  maxItems: number = MAX_DIGEST_ITEMS,
  part?: { index: number; total: number },
): DigestView {
  const unique = uniqueDigestEntries(entries);

  let budget = maxItems;
  const groups: DigestView['groups'] = [];
  for (const category of CATEGORY_ORDER) {
    const inCategory = unique.filter((entry) => entry.category === category);
    if (inCategory.length === 0) continue;
    const listed = inCategory.slice(0, Math.max(0, budget));
    budget -= listed.length;
    if (listed.length === 0) continue;
    groups.push({
      label: CATEGORY_LABELS[category],
      count: inCategory.length,
      items: listed.map((entry) => ({
        title: digestItemTitle(entry),
        url: entityUrl(appBaseUrl, entry.category, entry.entityId),
      })),
    });
  }
  const listedCount = groups.reduce((sum, group) => sum + group.items.length, 0);
  return {
    localDate,
    total: unique.length,
    plural: unique.length !== 1,
    groups,
    hasMore: unique.length > listedCount,
    moreCount: unique.length - listedCount,
    part: part && part.total > 1 ? { partIndex: part.index, partCount: part.total } : false,
    appUrl: appBaseUrl,
    preferencesUrl: preferencesUrl(appBaseUrl),
  };
}

export function renderDigest(view: DigestView): RenderedEmail {
  return renderEmail(TEMPLATES.digest, { ...view });
}

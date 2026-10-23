import { describe, expect, it } from 'vitest';
import {
  TEMPLATES,
  TemplateError,
  buildDigestView,
  digestItemTitle,
  entityUrl,
  renderDigest,
  renderImmediate,
  validateTemplate,
} from '../src/index.js';
import type { DigestEntry, NotificationRequest } from '../src/index.js';

const BASE = 'https://app.example.test/';

function request(overrides: Partial<NotificationRequest>): NotificationRequest {
  return {
    requestId: '6f1c2a40-3b7e-4c1d-9a8e-2f4b5c6d7e8f',
    userId: 'u-123',
    category: 'report_ready',
    entityId: 'rep-77',
    occurredAt: '2026-10-23T08:15:00Z',
    data: { reportName: 'Q3 usage' },
    ...overrides,
  };
}

describe('bundled templates', () => {
  it.each(Object.entries(TEMPLATES))('%s parses (subject, text, html)', (_id, source) => {
    validateTemplate(source.subject);
    validateTemplate(source.text);
    validateTemplate(source.html);
  });
});

describe('renderImmediate', () => {
  it('report_ready: escapes data in HTML and keeps it readable in text', () => {
    const rendered = renderImmediate(
      'report_ready',
      request({ data: { reportName: '<b>Q3</b> & "costs"' } }),
      BASE,
    );
    expect(rendered.subject).toBe('Your report "<b>Q3</b> & "costs"" is ready');
    expect(rendered.text).toContain('Your report "<b>Q3</b> & "costs"" is ready.');
    expect(rendered.html).toContain(
      '<strong>&lt;b&gt;Q3&lt;/b&gt; &amp; &quot;costs&quot;</strong>',
    );
    expect(rendered.html).toContain('href="https://app.example.test/reports/rep-77"');
    expect(rendered.html).not.toContain('<b>Q3</b>');
  });

  it('invoice_failed renders amount and currency', () => {
    const rendered = renderImmediate(
      'invoice_failed',
      request({
        category: 'invoice_failed',
        entityId: 'inv-9',
        data: { invoiceNumber: 'INV-9', amount: 49, currency: 'EUR' },
      }),
      BASE,
    );
    expect(rendered.subject).toBe('Payment failed for invoice INV-9');
    expect(rendered.text).toContain('(49 EUR)');
    expect(rendered.html).toContain('/billing/invoices/inv-9');
  });

  it('missing template data is an error, never a half-empty e-mail', () => {
    expect(() => renderImmediate('report_ready', request({ data: {} }), BASE)).toThrow(
      TemplateError,
    );
  });

  it('request data cannot override derived links', () => {
    const rendered = renderImmediate(
      'report_ready',
      request({ data: { reportName: 'x', entityUrl: 'https://evil.example.test' } }),
      BASE,
    );
    expect(rendered.html).not.toContain('evil.example.test');
  });

  it('entity ids are URL-encoded', () => {
    expect(entityUrl(BASE, 'report_ready', 'a/b?c')).toBe(
      'https://app.example.test/reports/a%2Fb%3Fc',
    );
  });
});

function entry(
  category: DigestEntry['category'],
  entityId: string,
  occurredAt: string,
  data = {},
): DigestEntry {
  return { category, entityId, occurredAt, data };
}

describe('digest', () => {
  it('groups by category in a fixed order, newest first, de-duplicated by entity', () => {
    const view = buildDigestView(
      [
        entry('report_ready', 'rep-1', '2026-10-22T10:00:00Z', { reportName: 'Old name' }),
        entry('report_ready', 'rep-1', '2026-10-22T11:00:00Z', { reportName: 'New name' }),
        entry('report_ready', 'rep-2', '2026-10-22T12:00:00Z', { reportName: 'Second' }),
        entry('comment_added', 'doc-1', '2026-10-22T09:00:00Z', { subject: 'Doc' }),
        entry('invoice_failed', 'inv-1', '2026-10-22T08:00:00Z', { invoiceNumber: 'INV-1' }),
      ],
      '2026-10-23',
      BASE,
    );
    expect(view.total).toBe(4);
    expect(view.groups.map((g) => [g.label, g.count])).toEqual([
      ['Billing', 1],
      ['Reports', 2],
      ['Comments', 1],
    ]);
    expect(view.groups[1]?.items.map((i) => i.title)).toEqual([
      'Report "Second" is ready',
      'Report "New name" is ready',
    ]);
    expect(view.hasMore).toBe(false);
  });

  it('caps the listed items and reports the rest', () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      entry('comment_added', `doc-${i}`, `2026-10-22T10:${String(i).padStart(2, '0')}:00Z`),
    );
    const view = buildDigestView(entries, '2026-10-23', BASE, 10);
    expect(view.groups[0]?.items).toHaveLength(10);
    expect(view.hasMore).toBe(true);
    expect(view.moreCount).toBe(20);
    expect(renderDigest(view).text).toContain('...and 20 more');
  });

  it('item titles fall back to the entity id instead of failing the digest', () => {
    expect(digestItemTitle(entry('usage_alert', 'use-1', 'x'))).toBe('Usage alert: use-1');
  });

  it('renders text and HTML, escaping item titles; the word-processor meta tags survive', () => {
    const view = buildDigestView(
      [
        entry('report_ready', 'rep-1', '2026-10-22T10:00:00Z', {
          reportName: '<img src=x onerror=alert(1)>',
        }),
      ],
      '2026-10-23',
      BASE,
    );
    const rendered = renderDigest(view);
    expect(rendered.subject).toBe('Your daily summary: 1 update');
    expect(rendered.html).toContain(
      '<meta name="Generator" content="Word-processor HTML export 15 (filtered medium)" />',
    );
    expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(rendered.html).not.toContain('<img');
    expect(rendered.text).toBe(
      [
        'Hello,',
        '',
        'Here is your summary for 2026-10-23.',
        '',
        'Reports (1)',
        '- Report "<img src=x onerror=alert(1)>" is ready',
        '  https://app.example.test/reports/rep-1',
        '',
        '--',
        'You get one summary per day for the categories you set to "daily digest".',
        'Manage notifications: https://app.example.test/settings/notifications',
        '',
      ].join('\n'),
    );
  });

  it('labels a part of a split digest in subject, text and html', () => {
    const view = buildDigestView(
      [entry('comment_added', 'a', '2026-10-22T10:00:00Z')],
      '2026-10-23',
      BASE,
      100,
      {
        index: 2,
        total: 3,
      },
    );
    const rendered = renderDigest(view);
    expect(rendered.subject).toBe('Your daily summary: 1 update (part 2/3)');
    expect(rendered.text).toContain('This is part 2 of 3.');
    expect(rendered.html).toContain('<p>This is part 2 of 3.</p>');
  });

  it('pluralises the subject', () => {
    const view = buildDigestView(
      [
        entry('comment_added', 'a', '2026-10-22T10:00:00Z'),
        entry('comment_added', 'b', '2026-10-22T10:00:00Z'),
      ],
      '2026-10-23',
      BASE,
    );
    expect(renderDigest(view).subject).toBe('Your daily summary: 2 updates');
  });
});

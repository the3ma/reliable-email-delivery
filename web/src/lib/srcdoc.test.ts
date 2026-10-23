import { describe, expect, it } from 'vitest';
import { buildEmailSrcDoc, EMAIL_CSP } from './srcdoc';

describe('buildEmailSrcDoc', () => {
  it('puts the CSP before any e-mail markup, even when <img> precedes <head>', () => {
    const doc = buildEmailSrcDoc(
      '<img src="https://x.example.test/p.gif"><html><head></head></html>',
    );
    const parsed = new DOMParser().parseFromString(doc, 'text/html');
    const first = parsed.head.firstElementChild;
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(first?.getAttribute('content')).toBe(EMAIL_CSP);
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<img'));
  });

  it('blocks every network fetch and script', () => {
    expect(EMAIL_CSP).toContain("default-src 'none'");
    expect(EMAIL_CSP).toContain('img-src data:');
    expect(EMAIL_CSP).not.toMatch(/script-src|https?:/);
  });
});

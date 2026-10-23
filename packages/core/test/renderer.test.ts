import { describe, expect, it } from 'vitest';
import { TemplateError, escapeHtml, render, renderEmail } from '../src/index.js';

const html = { escape: 'html' } as const;
const text = { escape: 'none' } as const;

describe('render: escaping', () => {
  it('escapes every interpolation in HTML mode', () => {
    expect(
      render('<p>{{name}}</p>', { name: `<script>alert("x")</script> & 'q' \`b\`` }, html),
    ).toBe(
      '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39; &#96;b&#96;</p>',
    );
  });

  it('escapes attribute values so data cannot break out of quotes', () => {
    expect(render('<a href="{{url}}">x</a>', { url: '" onclick="steal()' }, html)).toBe(
      '<a href="&quot; onclick=&quot;steal()">x</a>',
    );
  });

  it('does not escape in text mode', () => {
    expect(render('{{name}}', { name: 'A & B <c>' }, text)).toBe('A & B <c>');
  });

  it('renders numbers and booleans', () => {
    expect(render('{{n}} {{b}}', { n: 42, b: false }, html)).toBe('42 false');
  });

  it('escapeHtml leaves safe text alone', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });
});

describe('render: raw output is opt-in', () => {
  it('rejects {{{raw}}} and {{&raw}} by default', () => {
    expect(() => render('{{{body}}}', { body: '<b>x</b>' }, html)).toThrow(TemplateError);
    expect(() => render('{{&body}}', { body: '<b>x</b>' }, html)).toThrow(/not allowed/);
  });

  it('allows a raw variable only when explicitly whitelisted', () => {
    expect(
      render('{{{body}}}', { body: '<b>x</b>' }, { escape: 'html', allowRaw: new Set(['body']) }),
    ).toBe('<b>x</b>');
    expect(() =>
      render('{{{other}}}', { other: '<b>x</b>' }, { escape: 'html', allowRaw: new Set(['body']) }),
    ).toThrow(TemplateError);
  });
});

describe('render: strict variables', () => {
  it('a missing variable is an error, not an empty string', () => {
    expect(() => render('Hello {{name}}', {}, html)).toThrow('missing variable "name"');
    expect(() => render('{{a.b}}', { a: {} }, html)).toThrow(TemplateError);
    expect(() => render('{{a}}', { a: null }, html)).toThrow(TemplateError);
  });

  it('a missing section is an error too', () => {
    expect(() => render('{{#items}}x{{/items}}', {}, html)).toThrow(TemplateError);
  });

  it('objects cannot be interpolated', () => {
    expect(() => render('{{a}}', { a: { b: 1 } }, html)).toThrow(/not a scalar/);
  });

  it('does not read inherited properties', () => {
    expect(() => render('{{constructor}}', {}, html)).toThrow(TemplateError);
    expect(() => render('{{toString}}', { a: 1 }, html)).toThrow(TemplateError);
  });
});

describe('render: sections', () => {
  it('iterates lists with access to the parent scope', () => {
    const view = { base: 'https://app.example.test', items: [{ id: 'a' }, { id: 'b' }] };
    expect(render('{{#items}}[{{base}}/{{id}}]{{/items}}', view, html)).toBe(
      '[https://app.example.test/a][https://app.example.test/b]',
    );
  });

  it('nests lists', () => {
    const view = {
      groups: [
        { label: 'G1', items: [{ t: 'x' }, { t: 'y' }] },
        { label: 'G2', items: [{ t: 'z' }] },
      ],
    };
    expect(render('{{#groups}}{{label}}:{{#items}}{{t}}{{/items}};{{/groups}}', view, html)).toBe(
      'G1:xy;G2:z;',
    );
  });

  it('booleans, objects, {{.}} and inverted sections', () => {
    expect(render('{{#on}}yes{{/on}}{{#off}}no{{/off}}', { on: true, off: false }, html)).toBe(
      'yes',
    );
    expect(render('{{#user}}{{name}}{{/user}}', { user: { name: 'Ada' } }, html)).toBe('Ada');
    expect(render('{{#tags}}<{{.}}>{{/tags}}', { tags: ['a', 'b'] }, text)).toBe('<a><b>');
    expect(render('{{^items}}none{{/items}}', { items: [] }, html)).toBe('none');
    expect(render('{{^items}}none{{/items}}', { items: [1] }, html)).toBe('');
  });

  it('removes standalone section lines so text bodies stay tidy', () => {
    const template = 'Items:\n{{#items}}\n- {{.}}\n{{/items}}\nEnd\n';
    expect(render(template, { items: ['a', 'b'] }, text)).toBe('Items:\n- a\n- b\nEnd\n');
    expect(render('A\r\n{{! note }}\r\nB', {}, text)).toBe('A\r\nB');
  });

  it('rejects malformed templates', () => {
    expect(() => render('{{#a}}x', { a: true }, html)).toThrow(/unclosed section/);
    expect(() => render('{{#a}}x{{/b}}', { a: true }, html)).toThrow(/unexpected/);
    expect(() => render('{{name', { name: 'x' }, html)).toThrow(/unclosed tag/);
    expect(() => render('{{bad name}}', {}, html)).toThrow(/invalid tag name/);
  });
});

describe('regression: no blocklist regex', () => {
  // The old system scanned HTML for "unsafe" patterns and silently dropped every digest, because
  // word-processor exports carry <meta ... content=...> tags. Safety comes from escaping instead.
  it('renders a word-processor <meta content=...> template untouched', () => {
    const template =
      '<html><head><meta http-equiv=Content-Type content="text/html; charset=utf-8">' +
      '<meta name=Generator content="Word-processor HTML export 15 (filtered medium)">' +
      '</head><body><p class=MsoNormal>Hello {{name}}</p></body></html>';
    const out = render(template, { name: 'Ada' }, html);
    expect(out).toContain(
      '<meta name=Generator content="Word-processor HTML export 15 (filtered medium)">',
    );
    expect(out).toContain('<p class=MsoNormal>Hello Ada</p>');
  });

  it('a <meta> tag inside data is escaped, not executed and not blocked', () => {
    const out = render(
      '<p>{{note}}</p>',
      { note: '<meta http-equiv="refresh" content="0;url=https://evil.example.test">' },
      html,
    );
    expect(out).toBe(
      '<p>&lt;meta http-equiv=&quot;refresh&quot; content=&quot;0;url=https://evil.example.test&quot;&gt;</p>',
    );
  });
});

describe('renderEmail', () => {
  const source = { subject: 'Hi {{name}}', text: 'Hello {{name}}', html: '<p>{{name}}</p>' };

  it('produces subject, text and html', () => {
    expect(renderEmail(source, { name: 'A&B' })).toEqual({
      subject: 'Hi A&B',
      text: 'Hello A&B',
      html: '<p>A&amp;B</p>',
    });
  });

  it('folds line breaks in the subject (no header injection)', () => {
    expect(renderEmail(source, { name: 'x\r\nBcc: victim@example.test' }).subject).toBe(
      'Hi x Bcc: victim@example.test',
    );
  });

  it('rejects an empty subject', () => {
    expect(() => renderEmail({ ...source, subject: '{{name}}' }, { name: '  ' })).toThrow(
      /subject/,
    );
  });
});

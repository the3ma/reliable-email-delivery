/**
 * A deliberately small Mustache subset. Safety comes from escaping every interpolation, not from
 * scanning templates or data for "dangerous" patterns: a blocklist regex cannot tell a harmless
 * `<meta content=...>` from an attack and fails closed on legitimate mail.
 *
 *   {{name}} / {{a.b}} / {{.}}   escaped interpolation (HTML mode) - missing value is an error
 *   {{#list}}...{{/list}}        repeat for arrays, once for true/objects, skip for false/[]
 *   {{^list}}...{{/list}}        render when false or []
 *   {{! comment }}
 *   {{{name}}} / {{&name}}       raw - rejected unless the name is explicitly allowed
 */

export class TemplateError extends Error {
  override readonly name = 'TemplateError';
}

type Token =
  | { type: 'text'; value: string }
  | { type: 'var'; name: string; raw: boolean }
  | { type: 'section'; name: string; inverted: boolean; children: Token[] };

interface OpenSection {
  name: string;
  inverted: boolean;
  children: Token[];
}

const NAME = /^(?:\.|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/;
const STANDALONE_SPACE = /^[ \t]*$/;
const STANDALONE_TRAIL = /^[ \t]*\r?$/;

function parse(template: string): Token[] {
  const root: Token[] = [];
  const stack: OpenSection[] = [];
  const current = (): Token[] => stack.at(-1)?.children ?? root;
  let pos = 0;

  while (pos < template.length) {
    const open = template.indexOf('{{', pos);
    if (open === -1) {
      current().push({ type: 'text', value: template.slice(pos) });
      break;
    }
    const triple = template.startsWith('{{{', open);
    const closer = triple ? '}}}' : '}}';
    const close = template.indexOf(closer, open + closer.length);
    if (close === -1) throw new TemplateError(`unclosed tag at offset ${open}`);
    const end = close + closer.length;
    const body = template.slice(open + (triple ? 3 : 2), close).trim();
    const sigil = triple ? '{' : (body[0] ?? '');
    const isBlockTag = sigil === '#' || sigil === '^' || sigil === '/' || sigil === '!';

    // Mustache "standalone" rule: a block tag alone on its line takes the whole line with it,
    // so text bodies do not fill up with blank lines.
    let textEnd = open;
    let next = end;
    if (isBlockTag) {
      const lineStart = template.lastIndexOf('\n', open - 1) + 1;
      const newline = template.indexOf('\n', end);
      const lineEnd = newline === -1 ? template.length : newline;
      if (
        lineStart >= pos &&
        STANDALONE_SPACE.test(template.slice(lineStart, open)) &&
        STANDALONE_TRAIL.test(template.slice(end, lineEnd))
      ) {
        textEnd = lineStart;
        next = newline === -1 ? template.length : newline + 1;
      }
    }
    if (textEnd > pos) current().push({ type: 'text', value: template.slice(pos, textEnd) });
    pos = next;

    if (sigil === '!') continue;
    const name = triple ? body : sigil === '#' || sigil === '^' || sigil === '/' || sigil === '&' ? body.slice(1).trim() : body;
    if (!NAME.test(name)) throw new TemplateError(`invalid tag name "${name}"`);

    if (sigil === '#' || sigil === '^') {
      const section: OpenSection = { name, inverted: sigil === '^', children: [] };
      current().push({ type: 'section', ...section });
      stack.push(section);
    } else if (sigil === '/') {
      const section = stack.pop();
      if (section?.name !== name) {
        throw new TemplateError(`unexpected {{/${name}}}`);
      }
    } else {
      current().push({ type: 'var', name, raw: triple || sigil === '&' });
    }
  }
  const unclosed = stack.at(-1);
  if (unclosed) throw new TemplateError(`unclosed section "${unclosed.name}"`);
  return root;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (char) => HTML_ESCAPES[char] ?? char);
}

export type View = Readonly<Record<string, unknown>>;

export interface RenderOptions {
  /** `html` escapes every interpolation; `none` is for text bodies and subjects. */
  escape: 'html' | 'none';
  /** Names allowed in {{{raw}}} tags. Empty by default: raw output is opt-in per variable. */
  allowRaw?: ReadonlySet<string>;
}

const MISSING = Symbol('missing');

function lookup(stack: readonly unknown[], name: string): unknown {
  if (name === '.') return stack.at(-1);
  const [head, ...rest] = name.split('.');
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const scope = stack[i];
    if (scope !== null && typeof scope === 'object' && head !== undefined && Object.hasOwn(scope, head)) {
      let value: unknown = (scope as Record<string, unknown>)[head];
      for (const key of rest) {
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
          return MISSING;
        }
        value = (value as Record<string, unknown>)[key];
      }
      return value;
    }
  }
  return MISSING;
}

function renderTokens(tokens: readonly Token[], stack: unknown[], options: RenderOptions): string {
  let out = '';
  for (const token of tokens) {
    if (token.type === 'text') {
      out += token.value;
      continue;
    }
    const value = lookup(stack, token.name);
    if (value === MISSING || value === undefined || value === null) {
      throw new TemplateError(`missing variable "${token.name}"`);
    }
    if (token.type === 'var') {
      if (token.raw && !options.allowRaw?.has(token.name)) {
        throw new TemplateError(`raw interpolation of "${token.name}" is not allowed`);
      }
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new TemplateError(`variable "${token.name}" is not a scalar`);
      }
      const text = String(value);
      out += options.escape === 'html' && !token.raw ? escapeHtml(text) : text;
      continue;
    }
    const empty = value === false || (Array.isArray(value) && value.length === 0);
    if (token.inverted) {
      if (empty) out += renderTokens(token.children, stack, options);
    } else if (Array.isArray(value)) {
      for (const entry of value) out += renderTokens(token.children, [...stack, entry], options);
    } else if (value === true) {
      out += renderTokens(token.children, stack, options);
    } else if (typeof value === 'object') {
      out += renderTokens(token.children, [...stack, value], options);
    } else if (!empty) {
      throw new TemplateError(`section "${token.name}" needs a list, boolean or object`);
    }
  }
  return out;
}

const cache = new Map<string, Token[]>();

function compiled(template: string): Token[] {
  let tokens = cache.get(template);
  if (!tokens) {
    tokens = parse(template);
    cache.set(template, tokens);
  }
  return tokens;
}

export function render(template: string, view: View, options: RenderOptions): string {
  return renderTokens(compiled(template), [view], options);
}

/** Fails fast on syntax errors (used by tests over every bundled template). */
export function validateTemplate(template: string): void {
  compiled(template);
}

export interface TemplateSource {
  subject: string;
  text: string;
  html: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function renderEmail(
  source: TemplateSource,
  view: View,
  allowRaw?: ReadonlySet<string>,
): RenderedEmail {
  const rawOption = allowRaw ? { allowRaw } : {};
  // Subjects are a header: fold any line break so data cannot inject headers.
  const subject = render(source.subject, view, { escape: 'none', ...rawOption })
    .replace(/\s+/g, ' ')
    .trim();
  if (subject.length === 0) throw new TemplateError('subject rendered empty');
  return {
    subject,
    text: render(source.text, view, { escape: 'none', ...rawOption }),
    html: render(source.html, view, { escape: 'html', ...rawOption }),
  };
}

/** Fixture builders for the mock backend: fake example.test users, e-mail bodies and ids. */

export interface MockUser {
  userId: string;
  email: string;
  name: string;
}

const NAMES = [
  'ada',
  'ben',
  'cleo',
  'dara',
  'eli',
  'fay',
  'gus',
  'hana',
  'ivo',
  'jun',
  'kai',
  'lea',
  'max',
  'nia',
  'oli',
  'pia',
  'quinn',
  'rio',
  'sam',
  'tess',
] as const;

export const USERS: readonly MockUser[] = NAMES.map((name, i) => ({
  userId: `u-${String(i + 1).padStart(3, '0')}`,
  email: `${name}@example.test`,
  name: name.charAt(0).toUpperCase() + name.slice(1),
}));

export function userAt(index: number): MockUser {
  const user = USERS[index % USERS.length];
  if (!user) throw new Error('no users');
  return user;
}

export function mask(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.charAt(0)}***@${domain}`;
}

/** Deterministic 64-char hex (looks like the real sha256 ids; not cryptographic). */
export function fakeSha256(input: string): string {
  let out = '';
  let seed = 0x811c9dc5;
  for (let round = 0; out.length < 64; round++) {
    let h = seed ^ round;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    seed = h;
    out += (h >>> 0).toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

const wrap = (title: string, body: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#1f2933;background:#ffffff">
${body}
    <hr style="border:none;border-top:1px solid #d9dee3" />
    <p style="font-size:12px;color:#616e7c">
      You get this e-mail because of your notification settings.
      <a href="http://localhost:8080/settings/notifications" style="color:#616e7c">Manage notifications</a>
    </p>
  </body>
</html>`;

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export function reportReady(reportName: string, opts: { tracking?: boolean } = {}): RenderedMail {
  // The tracking variant shows what the preview blocks: a remote pixel and an inline script.
  const extras = opts.tracking
    ? `    <img src="https://tracker.example.test/open.gif?u=1" width="1" height="1" alt="" />
    <script>window.parent.postMessage('script ran', '*'); document.title = 'pwned';</script>
    <p><img src="https://cdn.example.test/banner.png" alt="Remote banner (blocked in the preview)" /></p>
`
    : '';
  return {
    subject: `Your report "${reportName}" is ready`,
    text: `Hello,\n\nYour report "${reportName}" is ready.\nOpen it: http://localhost:8080/reports/rep-77\n\nManage notifications: http://localhost:8080/settings/notifications\n`,
    html: wrap(
      'Your report is ready',
      `    <p>Hello,</p>
    <p>Your report <strong>${reportName}</strong> is ready.</p>
${extras}    <p>
      <a href="http://localhost:8080/reports/rep-77" style="display:inline-block;padding:10px 16px;background:#1f5fbf;color:#ffffff;text-decoration:none;border-radius:4px">Open the report</a>
    </p>`,
    ),
  };
}

export function invoiceFailed(): RenderedMail {
  return {
    subject: 'Action needed: an invoice payment failed',
    text: 'Hello,\n\nA payment for one of your invoices failed. Details are in the billing area.\n\nOpen billing: http://localhost:8080/billing\n',
    html: wrap(
      'An invoice payment failed',
      `    <p>Hello,</p>
    <p style="padding:12px;background:#fdf0dc;border-left:4px solid #8a4b00">A payment for one of your invoices failed.</p>
    <p>For your privacy the amount is not included in this e-mail.</p>
    <p><a href="http://localhost:8080/billing" style="color:#1f5fbf">Open billing</a></p>`,
    ),
  };
}

const DIGEST_ITEMS = [
  ['comment_added', 'New comment on "Roadmap draft"'],
  ['usage_alert', 'Storage usage reached 80 %'],
  ['comment_added', 'Reply in "Weekly sync notes"'],
  ['report_ready', 'Report "Monthly active users" is ready'],
  ['usage_alert', 'API calls reached 90 % of the plan'],
] as const;

export function digest(count: number, part?: { index: number; total: number }): RenderedMail {
  const items = Array.from({ length: count }, (_, i) => {
    const item = DIGEST_ITEMS[i % DIGEST_ITEMS.length] ?? DIGEST_ITEMS[0];
    return {
      category: item[0],
      title: `${item[1]}${i >= DIGEST_ITEMS.length ? ` (#${i + 1})` : ''}`,
    };
  });
  const suffix = part ? ` (part ${part.index}/${part.total})` : '';
  return {
    subject: `Your daily digest: ${count} update${count === 1 ? '' : 's'}${suffix}`,
    text: `Hello,\n\nHere is what happened since yesterday${suffix}:\n\n${items.map((i) => `- [${i.category}] ${i.title}`).join('\n')}\n`,
    html: wrap(
      `Your daily digest${suffix}`,
      `    <h1 style="font-size:20px;margin:0 0 12px">Your daily digest${suffix}</h1>
    <ul style="padding-left:20px">
${items.map((i) => `      <li style="margin:4px 0"><span style="color:#616e7c">[${i.category}]</span> ${i.title}</li>`).join('\n')}
    </ul>`,
    ),
  };
}

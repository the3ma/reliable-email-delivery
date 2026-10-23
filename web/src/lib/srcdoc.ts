/**
 * Policy for e-mail HTML shown in the Mailbox preview: nothing may load from the network (no
 * tracking pixels, remote fonts or styles), only inline styles and data: images render.
 * The iframe is also `sandbox=""`, so scripts, forms, popups and top navigation are blocked twice.
 */
export const EMAIL_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";

/**
 * Wraps untrusted e-mail HTML for `<iframe srcdoc>`. The CSP meta goes first, before any of the
 * e-mail's markup is parsed, so it applies even to malformed HTML that puts `<img>` before `<head>`;
 * the e-mail's own doctype/html/head tags after it are ignored or merged by the HTML parser.
 */
export function buildEmailSrcDoc(html: string): string {
  const csp = EMAIL_CSP.replace(/"/g, '&quot;');
  return (
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<meta name="referrer" content="no-referrer">` +
    html
  );
}

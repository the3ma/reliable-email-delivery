import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api/endpoints';
import type { MailMessage } from '../api/types';
import { Badge } from '../components/StatusChip';
import { EmptyState, ErrorState, Loading, StaleNotice } from '../components/States';
import { Tabs } from '../components/Tabs';
import { cx } from '../lib/cx';
import { formatBytes, formatDateTime, humanize, recipients, shortId } from '../lib/format';
import { useCursorPager, usePageTitle } from '../lib/hooks';
import { usePollingConfig } from '../lib/polling';
import { buildEmailSrcDoc } from '../lib/srcdoc';
import { useResource } from '../lib/useResource';
import styles from './MailboxPage.module.css';

const PAGE_SIZE = 25;

export function MailboxPage() {
  usePageTitle('Mailbox');
  const { mailId } = useParams();
  const { intervalMs, maxMs } = usePollingConfig();
  const pager = useCursorPager('mail');
  const list = useResource(
    `mail:${pager.cursor ?? ''}`,
    (signal) => api.mail({ limit: PAGE_SIZE, cursor: pager.cursor }, signal),
    { pollMs: pager.page === 1 ? intervalMs * 2.5 : undefined, maxBackoffMs: maxMs },
  );

  return (
    <>
      <h1>Mailbox</h1>
      <p className="muted">
        The local inbox (Mailpit) of the fake <code>example.test</code> users - the only view that
        shows real addresses. HTML is rendered in a sandbox with remote content blocked.
      </p>
      <div className={styles.layout}>
        <section aria-labelledby="inbox-h" className={cx('card', styles.inbox)}>
          <h2 id="inbox-h">Inbox</h2>
          {list.data && list.error ? <StaleNotice error={list.error} /> : null}
          {list.loading ? (
            <Loading label="Loading e-mails…" />
          ) : list.error && !list.data ? (
            <ErrorState error={list.error} onRetry={list.reload} />
          ) : list.data?.items.length === 0 ? (
            <EmptyState title="The inbox is empty">Run a scenario to send some e-mail.</EmptyState>
          ) : list.data ? (
            <>
              <ul className={styles.list}>
                {list.data.items.map((mail) => {
                  const selected = mail.id === mailId;
                  return (
                    <li key={mail.id}>
                      <Link
                        to={`/mailbox/${encodeURIComponent(mail.id)}`}
                        className={cx(styles.item, selected && styles.itemSelected)}
                        aria-current={selected ? 'true' : undefined}
                      >
                        <span className={styles.subject}>{mail.subject}</span>
                        <span className={styles.itemMeta}>
                          <span className={styles.to}>{recipients(mail.to)}</span>
                          <time dateTime={mail.createdAt}>{formatDateTime(mail.createdAt)}</time>
                        </span>
                        <span className={styles.itemMeta}>
                          {mail.category ? <Badge>{humanize(mail.category)}</Badge> : null}
                          <span className="muted">{formatBytes(mail.size)}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              <nav aria-label="Inbox pages" className={styles.pager}>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={pager.page === 1}
                  onClick={pager.previous}
                >
                  ← Newer
                </button>
                <span>Page {pager.page}</span>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={!list.data.nextCursor}
                  onClick={() => {
                    if (list.data?.nextCursor) pager.next(list.data.nextCursor);
                  }}
                >
                  Older →
                </button>
              </nav>
            </>
          ) : null}
        </section>

        <section aria-labelledby="preview-h" className={cx('card', styles.preview)}>
          {mailId ? (
            <MailPreview mailId={mailId} />
          ) : (
            <>
              <h2 id="preview-h">Preview</h2>
              <EmptyState title="No e-mail selected">Choose an e-mail from the inbox.</EmptyState>
            </>
          )}
        </section>
      </div>
    </>
  );
}

function MailPreview({ mailId }: { mailId: string }) {
  const mail = useResource(`mail-message:${mailId}`, (signal) => api.mailMessage(mailId, signal));
  if (mail.loading)
    return (
      <>
        <h2 id="preview-h">Preview</h2>
        <Loading label="Loading e-mail…" />
      </>
    );
  if (!mail.data)
    return (
      <>
        <h2 id="preview-h">Preview</h2>
        <ErrorState title="Could not load this e-mail" error={mail.error} onRetry={mail.reload} />
      </>
    );
  // Keyed so a new e-mail starts on the HTML tab.
  return <MailView key={mail.data.id} mail={mail.data} />;
}

type TabKey = 'html' | 'text' | 'headers';

function MailView({ mail }: { mail: MailMessage }) {
  const [tab, setTab] = useState<TabKey>('html');
  const deliveryId = mail.deliveryId ?? headerValue(mail.headers, 'X-Tag-deliveryId');

  return (
    <div className={styles.view}>
      <h2 id="preview-h" className={styles.previewTitle}>
        {mail.subject || '(no subject)'}
      </h2>
      <dl className={styles.facts}>
        <div>
          <dt>From</dt>
          <dd>{mail.from}</dd>
        </div>
        <div>
          <dt>To</dt>
          <dd>{recipients(mail.to)}</dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>{formatDateTime(mail.createdAt)}</dd>
        </div>
        <div>
          <dt>Delivery</dt>
          <dd>
            {deliveryId ? (
              <Link to={`/deliveries/${encodeURIComponent(deliveryId)}`} className="mono">
                {shortId(deliveryId)}
                <span className="visually-hidden"> (open the delivery)</span>
              </Link>
            ) : (
              <span className="muted">No deliveryId header</span>
            )}
          </dd>
        </div>
      </dl>
      <Tabs<TabKey>
        label="E-mail parts"
        selected={tab}
        onSelect={setTab}
        tabs={[
          { key: 'html', label: 'HTML', content: <HtmlPart mail={mail} /> },
          {
            key: 'text',
            label: 'Text',
            content: mail.text ? (
              <pre className={styles.text}>{mail.text}</pre>
            ) : (
              <p className="muted">This e-mail has no text part.</p>
            ),
          },
          { key: 'headers', label: 'Headers', content: <Headers mail={mail} /> },
        ]}
      />
    </div>
  );
}

function HtmlPart({ mail }: { mail: MailMessage }) {
  if (!mail.html) return <p className="muted">This e-mail has no HTML part.</p>;
  return (
    <>
      <p className={styles.sandboxNote}>
        <span aria-hidden="true">🛡 </span>
        Sandboxed: scripts, forms, pop-ups and remote content are blocked.
      </p>
      {/* sandbox="" = every restriction on; the srcdoc CSP blocks all network loads. */}
      <iframe
        className={styles.frame}
        title={`HTML body of "${mail.subject}"`}
        sandbox=""
        srcDoc={buildEmailSrcDoc(mail.html)}
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </>
  );
}

function Headers({ mail }: { mail: MailMessage }) {
  const rows = Object.entries(mail.headers).flatMap(([name, values]) =>
    values.map((value, i) => ({ key: `${name}-${String(i)}`, name, value })),
  );
  if (rows.length === 0) return <p className="muted">No headers.</p>;
  return (
    <div className="table-wrap">
      <table className={styles.headers}>
        <thead>
          <tr>
            <th scope="col">Header</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className="mono">
                {row.name}
              </th>
              <td className="mono">
                {row.name.toLowerCase() === 'x-tag-deliveryid' ? (
                  <Link to={`/deliveries/${encodeURIComponent(row.value)}`}>{row.value}</Link>
                ) : (
                  row.value
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Mailpit canonicalises header names (`X-Tag-Deliveryid`), so look them up case-insensitively. */
function headerValue(headers: Record<string, string[]>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  return entry?.[1][0];
}

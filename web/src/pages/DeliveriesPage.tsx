import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../api/endpoints';
import type { DeliveryQuery } from '../api/endpoints';
import type { DeliveryDetail } from '../api/types';
import { CATEGORIES, DELIVERY_STATUSES, KINDS } from '../api/types';
import { CopyButton } from '../components/CopyButton';
import { Modal } from '../components/Modal';
import { Badge, StatusChip } from '../components/StatusChip';
import { EmptyState, ErrorState, Loading, StaleNotice } from '../components/States';
import { cx } from '../lib/cx';
import { formatDateTime, humanize, shortId, STATUS_LABELS } from '../lib/format';
import { useCursorPager, usePageTitle } from '../lib/hooks';
import { usePollingConfig } from '../lib/polling';
import { useResource } from '../lib/useResource';
import styles from './DeliveriesPage.module.css';

const PAGE_SIZES = [25, 50, 100] as const;

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.find((item) => item === value);
}

export function DeliveriesPage() {
  usePageTitle('Deliveries');
  const { deliveryId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { intervalMs, maxMs } = usePollingConfig();

  const status = pick(params.get('status'), DELIVERY_STATUSES);
  const category = pick(params.get('category'), CATEGORIES);
  const kind = pick(params.get('kind'), KINDS);
  const limit = Number(params.get('limit')) || 50;
  const filterKey = `${status ?? ''}|${category ?? ''}|${kind ?? ''}|${limit}`;
  const pager = useCursorPager(filterKey);

  const query: DeliveryQuery = { status, category, kind, limit, cursor: pager.cursor };
  const list = useResource(
    `deliveries:${filterKey}:${pager.cursor ?? ''}`,
    (signal) => api.deliveries(query, signal),
    // Older pages do not change; only the first page follows new deliveries.
    { pollMs: pager.page === 1 ? intervalMs * 2.5 : undefined, maxBackoffMs: maxMs },
  );

  const setFilter = (name: 'status' | 'category' | 'kind' | 'limit', value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next);
  };

  const search = params.toString() ? `?${params.toString()}` : '';
  const closeDrawer = () => {
    void navigate(`/deliveries${search}`);
  };

  return (
    <>
      <h1>Deliveries</h1>
      <p className="muted">
        One row per delivery id (the dedup key). Newest first; recipients are masked.
      </p>

      <section aria-label="Filters" className={cx('card', styles.filters)}>
        <fieldset className={styles.chips}>
          <legend>Status</legend>
          <button
            type="button"
            className={cx(styles.chip, !status && styles.chipOn)}
            aria-pressed={!status}
            onClick={() => {
              setFilter('status', undefined);
            }}
          >
            All
          </button>
          {DELIVERY_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={cx(styles.chip, status === s && styles.chipOn)}
              aria-pressed={status === s}
              onClick={() => {
                setFilter('status', status === s ? undefined : s);
              }}
            >
              {status === s ? <span aria-hidden="true">✓ </span> : null}
              {STATUS_LABELS[s]}
            </button>
          ))}
        </fieldset>
        <div className={styles.selects}>
          <div className="field">
            <label htmlFor="f-category">Category</label>
            <select
              id="f-category"
              value={category ?? ''}
              onChange={(e) => {
                setFilter('category', e.target.value || undefined);
              }}
            >
              <option value="">All categories</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-kind">Kind</label>
            <select
              id="f-kind"
              value={kind ?? ''}
              onChange={(e) => {
                setFilter('kind', e.target.value || undefined);
              }}
            >
              <option value="">All kinds</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-limit">Rows per page</label>
            <select
              id="f-limit"
              value={limit}
              onChange={(e) => {
                setFilter('limit', e.target.value === '50' ? undefined : e.target.value);
              }}
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section aria-labelledby="results-h" className={styles.results}>
        <h2 id="results-h" className="visually-hidden">
          Results
        </h2>
        {list.data && list.error ? <StaleNotice error={list.error} /> : null}
        {list.loading ? (
          <Loading label="Loading deliveries…" />
        ) : list.error && !list.data ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : list.data?.items.length === 0 ? (
          <EmptyState title="No deliveries match">
            {status || category || kind
              ? 'Try another filter, or run a scenario.'
              : 'Run a scenario to see deliveries here.'}
          </EmptyState>
        ) : list.data ? (
          <>
            <div className="table-wrap">
              <table className={styles.table}>
                <caption className="visually-hidden">
                  Deliveries, page {pager.page}. Select a delivery id to see its timeline.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Delivery id</th>
                    <th scope="col">Category</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Recipient</th>
                    <th scope="col" className="num">
                      Attempts
                    </th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((d) => (
                    <tr
                      key={d.deliveryId}
                      className={cx(d.deliveryId === deliveryId && styles.selected)}
                    >
                      <td>
                        <StatusChip status={d.status} reason={d.reason ?? null} />
                      </td>
                      <td>
                        <Link
                          to={`/deliveries/${encodeURIComponent(d.deliveryId)}${search}`}
                          className="mono"
                          aria-label={`Delivery ${shortId(d.deliveryId)}, ${STATUS_LABELS[d.status]}: open details`}
                        >
                          {shortId(d.deliveryId)}
                        </Link>
                      </td>
                      <td>{humanize(d.category)}</td>
                      <td>
                        <Badge>{d.kind ?? 'unknown'}</Badge>
                      </td>
                      <td className="mono">{d.toMasked ?? 'unknown'}</td>
                      <td className="num">{d.attempts}</td>
                      <td className={styles.nowrap}>{formatDateTime(d.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav aria-label="Pagination" className={styles.pager}>
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

      {deliveryId ? <DeliveryDrawer deliveryId={deliveryId} onClose={closeDrawer} /> : null}
    </>
  );
}

function DeliveryDrawer({ deliveryId, onClose }: { deliveryId: string; onClose: () => void }) {
  const { intervalMs, maxMs } = usePollingConfig();
  const detail = useResource(
    `delivery:${deliveryId}`,
    (signal) => api.delivery(deliveryId, signal),
    { pollMs: intervalMs * 2.5, maxBackoffMs: maxMs },
  );

  return (
    <Modal title={`Delivery ${shortId(deliveryId)}`} onClose={onClose} variant="drawer">
      {detail.loading ? (
        <Loading label="Loading delivery…" />
      ) : detail.data ? (
        <DeliveryDetailView detail={detail.data} />
      ) : (
        <ErrorState
          title="Could not load this delivery"
          error={detail.error}
          onRetry={detail.reload}
        />
      )}
    </Modal>
  );
}

function DeliveryDetailView({ detail }: { detail: DeliveryDetail }) {
  const events = [...detail.events].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <>
      <dl className={styles.facts}>
        <div>
          <dt>Status</dt>
          <dd>
            <StatusChip status={detail.status} reason={detail.reason ?? null} />
          </dd>
        </div>
        <div>
          <dt>Delivery id</dt>
          <dd className={styles.idRow}>
            <code className={styles.fullId}>{detail.deliveryId}</code>
            <CopyButton value={detail.deliveryId} label="delivery id" />
          </dd>
        </div>
        <div>
          <dt>Recipient</dt>
          <dd className="mono">
            {detail.toMasked ?? 'unknown'} ({detail.userId ?? 'unknown user'})
          </dd>
        </div>
        <div>
          <dt>Category / kind</dt>
          <dd>
            {humanize(detail.category)} · {detail.kind ?? 'unknown'}
          </dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd>{detail.attempts}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatDateTime(detail.updatedAt)}</dd>
        </div>
        <div>
          <dt>E-mail</dt>
          <dd>
            {detail.mailId ? (
              <Link to={`/mailbox/${encodeURIComponent(detail.mailId)}`}>Open in the Mailbox</Link>
            ) : (
              <span className="muted">No e-mail found for this delivery id.</span>
            )}
          </dd>
        </div>
      </dl>

      {detail.status === 'AMBIGUOUS' ? (
        <p className={styles.callout}>
          <strong>Ambiguous:</strong> the worker's lease expired while sending, so nobody knows if
          the e-mail went out. It is never resent automatically (at-most-once); an alarm fires
          instead.
        </p>
      ) : null}

      <h3>State timeline</h3>
      {events.length === 0 ? (
        <p className="muted">No events recorded in the delivery log.</p>
      ) : (
        <ol className={styles.timeline}>
          {events.map((event, i) => (
            <li key={`${event.at}-${event.event}-${String(i)}`}>
              <span className={styles.dot} aria-hidden="true" />
              <div>
                <p className={styles.eventHead}>
                  <strong>{humanize(event.event)}</strong>{' '}
                  <time dateTime={event.at} className="muted">
                    {formatDateTime(event.at)}
                  </time>
                </p>
                {event.details && Object.keys(event.details).length > 0 ? (
                  <dl className={styles.details}>
                    {Object.entries(event.details).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd className="mono">
                          {typeof value === 'string' ? value : JSON.stringify(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

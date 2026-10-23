import { useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../api/client';
import { api } from '../api/endpoints';
import type { DigestResult, Overview, QueueDepth, ToggleValue } from '../api/types';
import { DELIVERY_STATUSES } from '../api/types';
import { ConfirmDialog } from '../components/Modal';
import { StatusChip } from '../components/StatusChip';
import { ErrorState, Loading, StaleNotice } from '../components/States';
import { cx } from '../lib/cx';
import { formatNumber, humanize, STATUS_HINTS, STATUS_LABELS } from '../lib/format';
import { usePageTitle } from '../lib/hooks';
import { usePollingConfig } from '../lib/polling';
import { useResource } from '../lib/useResource';
import styles from './DashboardPage.module.css';

export function DashboardPage() {
  usePageTitle('Dashboard');
  const { intervalMs, maxMs } = usePollingConfig();
  const overview = useResource('overview', (signal) => api.overview(signal), {
    pollMs: intervalMs,
    maxBackoffMs: maxMs,
  });

  return (
    <>
      <div className={styles.intro}>
        <h1>Dashboard</h1>
        <p className="muted">
          Live state of the local stack, refreshed every {Math.round(intervalMs / 1000)} s while
          this tab is visible.
        </p>
      </div>
      {overview.data ? (
        <>
          {overview.error ? <StaleNotice error={overview.error} /> : null}
          <OverviewView data={overview.data} onChanged={overview.reload} />
        </>
      ) : overview.error ? (
        <ErrorState error={overview.error} onRetry={overview.reload} />
      ) : (
        <Loading label="Loading overview…" />
      )}
    </>
  );
}

function OverviewView({ data, onChanged }: { data: Overview; onChanged: () => void }) {
  const skipped = Object.entries(data.skippedByReason).sort(([, a], [, b]) => b - a);
  const queues: [string, QueueDepth, boolean][] = [
    ['Intake', data.queues.intake, false],
    ['Intake DLQ', data.queues.intakeDlq, true],
    ['Email', data.queues.email, false],
    ['Email DLQ', data.queues.emailDlq, true],
  ];

  return (
    <div className={styles.grid}>
      <section aria-labelledby="counts-h" className={cx('card', styles.wide)}>
        <h2 id="counts-h">Deliveries by state</h2>
        <ul className={styles.tiles}>
          {DELIVERY_STATUSES.map((status) => (
            <li key={status}>
              <Link
                to={`/deliveries?status=${status}`}
                className={styles.tile}
                aria-label={`${STATUS_LABELS[status]}: ${formatNumber(data.counts[status])} - ${STATUS_HINTS[status]}`}
              >
                <StatusChip status={status} />
                <span className={styles.count}>{formatNumber(data.counts[status])}</span>
                <span className={styles.hint}>{STATUS_HINTS[status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <KillSwitch value={data.toggles.sendEmails} onChanged={onChanged} />

      <section aria-labelledby="skipped-h" className="card">
        <h2 id="skipped-h">Skipped by reason</h2>
        {skipped.length === 0 ? (
          <p className="muted">Nothing skipped yet.</p>
        ) : (
          <dl className={styles.pairs}>
            {skipped.map(([reason, count]) => (
              <div key={reason}>
                <dt>{humanize(reason)}</dt>
                <dd>{formatNumber(count)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section aria-labelledby="queues-h" className="card">
        <h2 id="queues-h">Queues</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Queue</th>
                <th scope="col" className="num">
                  Visible
                </th>
                <th scope="col" className="num">
                  In flight
                </th>
              </tr>
            </thead>
            <tbody>
              {queues.map(([name, depth, dlq]) => {
                const alert = dlq && depth.visible + depth.inFlight > 0;
                return (
                  <tr key={name} className={cx(alert && styles.alertRow)}>
                    <th scope="row">
                      {name}
                      {alert ? <span className={styles.flag}> needs attention</span> : null}
                    </th>
                    <td className="num">{formatNumber(depth.visible)}</td>
                    <td className="num">{formatNumber(depth.inFlight)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="totals-h" className="card">
        <h2 id="totals-h">Totals</h2>
        <dl className={styles.pairs}>
          <div>
            <dt>
              <Link to="/mailbox">E-mails in the Mailbox</Link>
            </dt>
            <dd>{formatNumber(data.mail.total)}</dd>
          </div>
          <div>
            <dt>
              <Link to="/suppressions">Suppressed addresses</Link>
            </dt>
            <dd>{formatNumber(data.suppressions.total)}</dd>
          </div>
          <div>
            <dt>Subscriptions</dt>
            <dd>{formatNumber(data.subscriptions.total)}</dd>
          </div>
          <div>
            <dt>Delivery recording</dt>
            <dd>{humanize(data.toggles.recordDeliveries)}</dd>
          </div>
        </dl>
      </section>

      <DemoActions onChanged={onChanged} />
    </div>
  );
}

function KillSwitch({ value, onChanged }: { value: ToggleValue; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabled = value === 'enabled';
  const target: ToggleValue = enabled ? 'disabled' : 'enabled';

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.setSendEmails(target);
      setNote(`Sending is now ${result.value}. ${result.note}`);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <section aria-labelledby="kill-h" className={cx('card', styles.kill)}>
      <h2 id="kill-h">Kill switch</h2>
      <p className={styles.toggleState}>
        Sending e-mails:{' '}
        <strong className={enabled ? styles.on : styles.off}>
          <span aria-hidden="true">{enabled ? '● ' : '○ '}</span>
          {enabled ? 'Enabled' : 'Disabled'}
        </strong>
      </p>
      <p className="muted">
        SSM parameter <code>send-emails</code>. While disabled the processor records every e-mail as{' '}
        <code>SKIPPED(disabled)</code> instead of sending it - no deployment needed.
      </p>
      <button
        type="button"
        className={enabled ? 'btn btn-danger' : 'btn btn-primary'}
        onClick={() => {
          setConfirming(true);
        }}
      >
        {enabled ? 'Disable sending…' : 'Enable sending…'}
      </button>
      <div aria-live="polite" className={styles.feedback}>
        {note ? <p>{note}</p> : null}
      </div>
      {error ? (
        <p role="alert" className="field-error">
          Could not change the toggle: {error}
        </p>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title={enabled ? 'Disable sending e-mails?' : 'Enable sending e-mails?'}
          description={
            enabled
              ? 'New e-mails will be skipped with reason "disabled" until you enable sending again. Skipped e-mails are not resent later.'
              : 'The processor resumes sending new e-mails once it picks up the change.'
          }
          confirmLabel={enabled ? 'Disable sending' : 'Enable sending'}
          danger={enabled}
          busy={busy}
          onConfirm={() => void apply()}
          onCancel={() => {
            setConfirming(false);
          }}
        />
      ) : null}
    </section>
  );
}

function DemoActions({ onChanged }: { onChanged: () => void }) {
  const [busy, setBusy] = useState<'digest' | 'reset' | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runDigest = async () => {
    setBusy('digest');
    setError(null);
    try {
      const r: DigestResult = await api.runDigest({ all: true, ignoreWindow: true });
      setMessage(
        `Digest run: ${r.users} users, ${r.queued} queued, ${r.alreadyDelivered} already delivered, ${r.parts} parts${r.failed ? `, ${r.failed} failed` : ''}.`,
      );
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    setBusy('reset');
    setError(null);
    try {
      await api.reset();
      setMessage(
        'Demo data reset: deliveries, logs, digests, Mailpit cleared; subscriptions seeded.',
      );
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
      setConfirmReset(false);
    }
  };

  return (
    <section aria-labelledby="actions-h" className="card">
      <h2 id="actions-h">Demo actions</h2>
      <div className={styles.actions}>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => void runDigest()}
        >
          {busy === 'digest' ? 'Running digest…' : 'Run digest now (all segments)'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => {
            setConfirmReset(true);
          }}
        >
          Reset demo data…
        </button>
      </div>
      <div aria-live="polite" className={styles.feedback}>
        {message ? <p>{message}</p> : null}
      </div>
      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
      {confirmReset ? (
        <ConfirmDialog
          title="Reset the demo data?"
          description="Clears deliveries, the delivery log, pending digests, non-seeded suppressions and the Mailbox, then re-seeds subscriptions."
          confirmLabel="Reset"
          danger
          busy={busy === 'reset'}
          onConfirm={() => void reset()}
          onCancel={() => {
            setConfirmReset(false);
          }}
        />
      ) : null}
    </section>
  );
}

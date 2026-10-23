import { useId, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import { errorMessage } from '../api/client';
import { api } from '../api/endpoints';
import type { FeedbackType } from '../api/types';
import { CopyButton } from '../components/CopyButton';
import { Badge } from '../components/StatusChip';
import { EmptyState, ErrorState, Loading, StaleNotice } from '../components/States';
import { cx } from '../lib/cx';
import { formatDateTime, formatShortDateTime, humanize, shortId } from '../lib/format';
import { usePageTitle } from '../lib/hooks';
import { usePollingConfig } from '../lib/polling';
import { useResource } from '../lib/useResource';
import styles from './SuppressionsPage.module.css';

/** Only the demo's fake domain may be used, so the form can never target a real mailbox. */
export const EXAMPLE_ADDRESS = /^[^\s@]+@example\.test$/i;

export function SuppressionsPage() {
  usePageTitle('Suppressions');
  const { intervalMs, maxMs } = usePollingConfig();
  const list = useResource('suppressions', (signal) => api.suppressions(signal), {
    pollMs: intervalMs * 2.5,
    maxBackoffMs: maxMs,
  });

  return (
    <>
      <h1>Suppressions</h1>
      <p className="muted">
        Addresses that bounced permanently or complained are never mailed again. Only a SHA-256 hash
        of the lower-cased address is stored.
      </p>
      <div className={styles.layout}>
        <section aria-labelledby="supp-h" className={styles.tableSection}>
          <h2 id="supp-h">Suppression list</h2>
          {list.data && list.error ? <StaleNotice error={list.error} /> : null}
          {list.loading ? (
            <Loading label="Loading suppressions…" />
          ) : list.error && !list.data ? (
            <ErrorState error={list.error} onRetry={list.reload} />
          ) : list.data?.items.length === 0 ? (
            <EmptyState title="Nothing is suppressed">
              Simulate a bounce or complaint to add an entry.
            </EmptyState>
          ) : list.data ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Address hash</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Source</th>
                    <th scope="col">Created</th>
                    <th scope="col">Last event</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((s) => (
                    <tr key={s.emailHash}>
                      <td>
                        <span className={styles.hash}>
                          <code title={s.emailHash}>{shortId(s.emailHash, 10, 6)}</code>
                          <CopyButton value={s.emailHash} label="address hash" />
                        </span>
                      </td>
                      <td>
                        <Badge>{humanize(s.reason)}</Badge>
                      </td>
                      <td className={styles.nowrap}>{s.source}</td>
                      <td className={styles.nowrap}>
                        <time dateTime={s.createdAt} title={formatDateTime(s.createdAt)}>
                          {formatShortDateTime(s.createdAt)}
                        </time>
                      </td>
                      <td className={styles.nowrap}>
                        <time dateTime={s.lastEventAt} title={formatDateTime(s.lastEventAt)}>
                          {formatShortDateTime(s.lastEventAt)}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
        <FeedbackForm onDone={list.reload} />
      </div>
    </>
  );
}

const TYPES: readonly { value: FeedbackType; label: string; hint: string }[] = [
  { value: 'bounce', label: 'Bounce', hint: 'permanent unless marked transient' },
  { value: 'complaint', label: 'Complaint', hint: 'the recipient marked it as spam' },
  { value: 'delivery', label: 'Delivery', hint: 'logged only, never suppresses' },
];

function FeedbackForm({ onDone }: { onDone: () => void }) {
  const [type, setType] = useState<FeedbackType>('bounce');
  const [email, setEmail] = useState('');
  const [transient, setTransient] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = { email: useId(), hint: useId(), error: useId(), transient: useId() };

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setResult(null);
    setError(null);
    const address = email.trim();
    if (!EXAMPLE_ADDRESS.test(address)) {
      setFieldError('Enter a fake address ending in @example.test, e.g. ada@example.test.');
      inputRef.current?.focus();
      return;
    }
    setFieldError(null);
    setBusy(true);
    try {
      const res = await api.feedback({
        type,
        email: address,
        ...(type === 'bounce' && transient ? { transient: true } : {}),
      });
      setResult(
        res.suppressed
          ? `${humanize(type)} recorded: the address is now suppressed.`
          : `${humanize(type)} recorded: the address is not suppressed.`,
      );
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="sim-h" className={cx('card', styles.form)}>
      <h2 id="sim-h">Simulate SES feedback</h2>
      <p className="muted">
        Builds the real SES event and runs the feedback handler against the local stack.
      </p>
      <form noValidate onSubmit={(e) => void submit(e)}>
        <fieldset className={styles.types}>
          <legend>Event type</legend>
          {TYPES.map((t) => (
            <label key={t.value} className={styles.radio}>
              <input
                type="radio"
                name="feedback-type"
                value={t.value}
                checked={type === t.value}
                onChange={() => {
                  setType(t.value);
                }}
              />
              <span>
                {t.label} <span className="field-hint">- {t.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor={ids.email}>Recipient address</label>
          <input
            ref={inputRef}
            id={ids.email}
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={email}
            placeholder="ada@example.test"
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${ids.hint} ${ids.error}` : ids.hint}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
          <span id={ids.hint} className="field-hint">
            Fake <code>@example.test</code> addresses only.
          </span>
          {fieldError ? (
            <span id={ids.error} className="field-error">
              {fieldError}
            </span>
          ) : null}
        </div>
        {type === 'bounce' ? (
          <label htmlFor={ids.transient} className={styles.checkbox}>
            <input
              id={ids.transient}
              type="checkbox"
              checked={transient}
              onChange={(e) => {
                setTransient(e.target.checked);
              }}
            />
            Transient bounce (mailbox full) - logged, not suppressed
          </label>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Sending event…' : 'Simulate event'}
        </button>
      </form>
      <div aria-live="polite" className={styles.result}>
        {result ? <p>{result}</p> : null}
      </div>
      {error ? (
        <p role="alert" className="field-error">
          Could not simulate the event: {error}
        </p>
      ) : null}
    </section>
  );
}

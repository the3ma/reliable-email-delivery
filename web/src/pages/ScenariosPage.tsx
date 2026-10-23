import { useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage, isAbort } from '../api/client';
import { api } from '../api/endpoints';
import type { Overview, Scenario, ScenarioRun, ScenarioRunPhase } from '../api/types';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { cx } from '../lib/cx';
import { formatNumber, formatTime } from '../lib/format';
import { usePageTitle } from '../lib/hooks';
import { usePollingConfig } from '../lib/polling';
import { useResource } from '../lib/useResource';
import styles from './ScenariosPage.module.css';

interface Metric {
  label: string;
  read: (o: Overview) => number;
}

const METRICS: readonly Metric[] = [
  { label: 'E-mails in the Mailbox', read: (o) => o.mail.total },
  { label: 'Sent', read: (o) => o.counts.SENT },
  { label: 'Skipped (suppressed)', read: (o) => o.skippedByReason.suppressed ?? 0 },
  { label: 'Skipped (disabled)', read: (o) => o.skippedByReason.disabled ?? 0 },
  { label: 'Skipped (invalid)', read: (o) => invalidSkips(o) },
  { label: 'Failed (permanent)', read: (o) => o.counts.FAILED_PERMANENT },
  { label: 'Ambiguous', read: (o) => o.counts.AMBIGUOUS },
  { label: 'Suppressed addresses', read: (o) => o.suppressions.total },
  {
    label: 'Messages in DLQs',
    read: (o) => o.queues.intakeDlq.visible + o.queues.emailDlq.visible,
  },
];

/** console-api reports invalid skips per cause (`invalid:html_too_large`...); one bucket here. */
function invalidSkips(o: Overview): number {
  return Object.entries(o.skippedByReason)
    .filter(([reason]) => reason === 'invalid' || reason.startsWith('invalid:'))
    .reduce((sum, [, n]) => sum + n, 0);
}

const inQueues = (o: Overview) =>
  o.queues.intake.visible +
  o.queues.intake.inFlight +
  o.queues.email.visible +
  o.queues.email.inFlight;

const fingerprint = (o: Overview) => METRICS.map((m) => m.read(o)).join(',');

/** Polls after a run this many times at most before it stops watching. */
const MAX_POLLS = 60;
/** The run counts as settled when the queues are empty and nothing changed for this many polls. */
const STABLE_POLLS = 2;

type RunState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | {
      phase: 'running' | 'settled' | 'stopped' | 'failed';
      run: ScenarioRun;
      /** Server-side run status from GET /scenarios/runs/{runId}, when available. */
      server: ScenarioRunPhase | undefined;
      before: Overview;
      latest: Overview;
      polls: number;
    }
  | { phase: 'error'; message: string };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/** Resolves once the tab is visible, so a hidden tab does not keep polling. */
function whenVisible(signal: AbortSignal): Promise<void> {
  if (document.visibilityState !== 'hidden') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onChange = () => {
      if (document.visibilityState === 'hidden') return;
      document.removeEventListener('visibilitychange', onChange);
      resolve();
    };
    document.addEventListener('visibilitychange', onChange);
    signal.addEventListener(
      'abort',
      () => {
        document.removeEventListener('visibilitychange', onChange);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

export function ScenariosPage() {
  usePageTitle('Scenarios');
  const scenarios = useResource('scenarios', (signal) => api.scenarios(signal));
  const [activeId, setActiveId] = useState<string | null>(null);

  let body;
  if (scenarios.loading) body = <Loading label="Loading scenarios…" />;
  else if (scenarios.error)
    body = <ErrorState error={scenarios.error} onRetry={scenarios.reload} />;
  else if (!scenarios.data || scenarios.data.length === 0)
    body = <EmptyState title="No scenarios available">The console API returned none.</EmptyState>;
  else
    body = (
      <ul className={styles.list}>
        {scenarios.data.map((scenario) => (
          <li key={scenario.id}>
            <ScenarioCard
              scenario={scenario}
              blocked={activeId !== null && activeId !== scenario.id}
              onActive={(active) => {
                setActiveId(active ? scenario.id : null);
              }}
            />
          </li>
        ))}
      </ul>
    );

  return (
    <>
      <h1>Scenarios</h1>
      <p className="muted">
        Each scenario publishes real requests to the local stack. Run one and compare what is
        expected with what the workers actually did. One scenario runs at a time so the counters are
        not mixed up.
      </p>
      {body}
    </>
  );
}

function ScenarioCard({
  scenario,
  blocked,
  onActive,
}: {
  scenario: Scenario;
  blocked: boolean;
  onActive: (active: boolean) => void;
}) {
  const { intervalMs } = usePollingConfig();
  const [state, setState] = useState<RunState>({ phase: 'idle' });
  const controllerRef = useRef<AbortController | null>(null);
  const headingId = `scenario-${scenario.id}`;

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  const run = async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    onActive(true);
    setState({ phase: 'starting' });
    try {
      const before = await api.overview(signal);
      let run: ScenarioRun = await api.runScenario(scenario.id);
      let server: ScenarioRunPhase | undefined = 'running';
      let latest = before;
      let polls = 0;
      let stable = 0;
      let last = fingerprint(before);
      setState({ phase: 'running', run, server, before, latest, polls });
      while (polls < MAX_POLLS) {
        await sleep(intervalMs, signal);
        await whenVisible(signal);
        polls += 1;
        try {
          // Background scenarios (kill-switch, bounce) keep working after the POST returns;
          // the run status says when they are finished and carries their notes.
          const [status, overview] = await Promise.all([
            api.scenarioRun(run.runId, signal).catch((err: unknown) => {
              if (isAbort(err)) throw err;
              return undefined;
            }),
            api.overview(signal),
          ]);
          if (status) {
            run = status;
            server = status.status;
          } else {
            server = undefined;
          }
          latest = overview;
        } catch (err) {
          if (isAbort(err)) throw err;
          continue; // a failed poll just waits for the next one
        }
        if (server === 'failed') {
          setState({ phase: 'failed', run, server, before, latest, polls });
          return;
        }
        const print = fingerprint(latest);
        const quiet = print === last && inQueues(latest) === 0 && server !== 'running';
        stable = quiet ? stable + 1 : 0;
        last = print;
        const done = stable >= STABLE_POLLS;
        setState({ phase: done ? 'settled' : 'running', run, server, before, latest, polls });
        if (done) return;
      }
      setState({ phase: 'stopped', run, server, before, latest, polls });
    } catch (err) {
      if (isAbort(err)) return;
      setState({
        phase: 'error',
        message:
          err instanceof ApiError && err.code === 'run_in_progress'
            ? 'A scenario is already running. Try again once it has finished.'
            : errorMessage(err),
      });
    } finally {
      if (!signal.aborted) onActive(false);
    }
  };

  const busy = state.phase === 'starting' || state.phase === 'running';

  return (
    <article className={cx('card', styles.card)} aria-labelledby={headingId}>
      <div className={styles.cardHead}>
        <h2 id={headingId}>{scenario.title}</h2>
        <code className={styles.id}>{scenario.id}</code>
      </div>
      <p>{scenario.description}</p>
      <div className={styles.expected}>
        <span className={styles.label}>Expected</span>
        <p>{scenario.expected}</p>
      </div>
      <div className={styles.runRow}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || blocked}
          onClick={() => void run()}
          aria-describedby={blocked ? `${headingId}-blocked` : undefined}
        >
          {busy ? 'Running…' : state.phase === 'idle' ? 'Run scenario' : 'Run again'}
        </button>
        {blocked ? (
          <span id={`${headingId}-blocked`} className="muted">
            Another scenario is running.
          </span>
        ) : null}
      </div>
      <p className={styles.progress} aria-live="polite" role="status">
        {progressText(scenario, state)}
      </p>
      {'before' in state ? <Observed state={state} /> : null}
      {state.phase === 'error' ? (
        <p role="alert" className="field-error">
          Run failed: {state.message}
        </p>
      ) : null}
    </article>
  );
}

function progressText(scenario: Scenario, state: RunState): string {
  switch (state.phase) {
    case 'idle':
    case 'error':
      return '';
    case 'starting':
      return `Starting "${scenario.title}"…`;
    case 'running':
      return state.server === 'running'
        ? `Running: published ${state.run.published}; the scenario is still working (${state.polls} checks so far).`
        : `Running: published ${state.run.published}; watching the workers (${state.polls} checks so far).`;
    case 'failed':
      return `The scenario failed on the server. ${summary(state.before, state.latest)}`;
    case 'settled':
      return `Settled: the queues are empty and the counters stopped changing. ${summary(state.before, state.latest)}`;
    case 'stopped':
      return `Stopped watching after ${state.polls} checks. ${summary(state.before, state.latest)}`;
  }
}

function summary(before: Overview, after: Overview): string {
  const changes = METRICS.map((m) => [m.label, m.read(after) - m.read(before)] as const)
    .filter(([, delta]) => delta !== 0)
    .map(([label, delta]) => `${label} ${delta > 0 ? '+' : ''}${delta}`);
  return changes.length ? `Observed: ${changes.join(', ')}.` : 'Observed: no changes.';
}

function Observed({ state }: { state: Extract<RunState, { before: Overview }> }) {
  const notes = state.run.notes;
  return (
    <section className={styles.observed} aria-label={`Observed result of run ${state.run.runId}`}>
      <h3>Observed</h3>
      <p className={styles.meta}>
        Run <code>{state.run.runId}</code> started {formatTime(state.run.startedAt)} ·{' '}
        {formatNumber(state.run.published)} published
      </p>
      {notes.filter(Boolean).length > 0 ? (
        <ul className={styles.notes}>
          {notes.filter(Boolean).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Counter</th>
              <th scope="col" className="num">
                Before
              </th>
              <th scope="col" className="num">
                Now
              </th>
              <th scope="col" className="num">
                Change
              </th>
            </tr>
          </thead>
          <tbody>
            {METRICS.map((metric) => {
              const before = metric.read(state.before);
              const now = metric.read(state.latest);
              const delta = now - before;
              return (
                <tr key={metric.label} className={cx(delta !== 0 && styles.changed)}>
                  <th scope="row">{metric.label}</th>
                  <td className="num">{formatNumber(before)}</td>
                  <td className="num">{formatNumber(now)}</td>
                  <td className="num">
                    {delta === 0 ? 'no change' : `${delta > 0 ? '+' : ''}${formatNumber(delta)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

import type { ReactNode } from 'react';
import { errorMessage } from '../api/client';
import styles from './States.module.css';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className={styles.state} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      {label}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={styles.state}>
      <p className={styles.title}>{title}</p>
      {children ? <div className={styles.body}>{children}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = 'Could not load this view',
  error,
  onRetry,
}: {
  title?: string;
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <div className={styles.error} role="alert">
      <p className={styles.title}>
        <span aria-hidden="true">⚠ </span>
        {title}
      </p>
      <p className={styles.body}>{errorMessage(error)}</p>
      {onRetry ? (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** A thin warning shown above stale data when a background poll fails. */
export function StaleNotice({ error }: { error: unknown }) {
  return (
    <p className={styles.stale} role="status">
      <span aria-hidden="true">⚠ </span>
      Live updates paused: {errorMessage(error)} Retrying with back-off.
    </p>
  );
}

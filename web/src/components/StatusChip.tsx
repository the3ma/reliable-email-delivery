import type { DeliveryStatus } from '../api/types';
import { cx } from '../lib/cx';
import { STATUS_LABELS } from '../lib/format';
import styles from './StatusChip.module.css';

// A glyph per state as a second, non-colour cue next to the text label.
const GLYPHS: Readonly<Record<DeliveryStatus, string>> = {
  SENT: '✓',
  SKIPPED: '–',
  RELEASED: '↻',
  CLAIMED: '…',
  FAILED_PERMANENT: '✕',
  AMBIGUOUS: '?',
};

export function StatusChip({ status, reason }: { status: DeliveryStatus; reason?: string | null }) {
  return (
    <span className={cx(styles.chip, styles[status])}>
      <span aria-hidden="true" className={styles.glyph}>
        {GLYPHS[status]}
      </span>
      {STATUS_LABELS[status]}
      {reason ? <span className={styles.reason}>({reason})</span> : null}
    </span>
  );
}

export function Badge({ children }: { children: string }) {
  return <span className={styles.badge}>{children}</span>;
}

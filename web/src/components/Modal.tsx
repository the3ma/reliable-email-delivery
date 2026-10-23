import { useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/cx';
import { useFocusTrap } from '../lib/useFocusTrap';
import styles from './Modal.module.css';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** `drawer` slides in from the right; `dialog` is centred. */
  variant?: 'drawer' | 'dialog';
  /** `alertdialog` for confirmations that need an explicit answer. */
  role?: 'dialog' | 'alertdialog';
  description?: string;
}

/** Accessible modal: labelled, focus trapped, Escape and backdrop close, focus returns on close. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  variant = 'dialog',
  role = 'dialog',
  description,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useFocusTrap(panelRef, onClose);

  return createPortal(
    <div className={cx(styles.backdrop, variant === 'drawer' && styles.drawerBackdrop)}>
      <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(styles.panel, variant === 'drawer' ? styles.drawer : styles.dialog)}
      >
        <header className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <button
            type="button"
            className={cx('btn btn-small', styles.close)}
            onClick={onClose}
            aria-label="Close"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </header>
        <div className={styles.body}>
          {description ? (
            <p id={descId} className={styles.description}>
              {description}
            </p>
          ) : null}
          {children}
        </div>
        {footer ? <footer className={styles.foot}>{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmProps {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  return (
    <Modal
      title={title}
      description={description}
      role="alertdialog"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} data-autofocus>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {null}
    </Modal>
  );
}

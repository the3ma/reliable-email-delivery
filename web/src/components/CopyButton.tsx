import { useEffect, useState } from 'react';

type CopyState = 'idle' | 'copied' | 'failed';

/** Copies `value`; the result is announced through the button's live label. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<CopyState>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => {
      setState('idle');
    }, 2_000);
    return () => {
      clearTimeout(timer);
    };
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return (
    <>
      <button
        type="button"
        className="btn btn-small"
        onClick={() => void copy()}
        aria-label={`Copy ${label}`}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
      </button>
      <span className="visually-hidden" aria-live="polite">
        {state === 'copied' ? `${label} copied` : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </>
  );
}

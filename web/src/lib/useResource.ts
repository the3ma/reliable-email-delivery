import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbort } from '../api/client';
import { usePageVisible } from './usePageVisible';

export type Loader<T> = (signal: AbortSignal) => Promise<T>;

export interface ResourceOptions {
  /** Poll every `pollMs` while the tab is visible; omit to load once per key. */
  pollMs?: number | undefined;
  /** Upper bound for the doubling back-off after consecutive failures. */
  maxBackoffMs?: number | undefined;
  /** Skip loading entirely (e.g. no item selected). */
  enabled?: boolean | undefined;
}

export interface Resource<T> {
  /** Last good data for the current key (kept while a poll fails, so the view does not blank). */
  data: T | undefined;
  error: Error | undefined;
  /** True until the first response for the current key arrives. */
  loading: boolean;
  reload: () => void;
}

interface State<T> {
  key: string | null;
  data: T | undefined;
  error: Error | undefined;
}

/**
 * Loads `key` with `load` and, with `pollMs`, keeps polling it: the interval doubles after each
 * failure up to `maxBackoffMs` and resets on success. Polling pauses while the tab is hidden and
 * refreshes immediately when it becomes visible again. A key change aborts the in-flight request.
 */
export function useResource<T>(
  key: string,
  load: Loader<T>,
  { pollMs, maxBackoffMs = 30_000, enabled = true }: ResourceOptions = {},
): Resource<T> {
  const visible = usePageVisible();
  const loadRef = useRef(load);
  const [state, setState] = useState<State<T>>({ key: null, data: undefined, error: undefined });
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    loadRef.current = load;
  });

  // A one-shot resource still loads while hidden; only polling pauses.
  const paused = !visible && pollMs !== undefined;

  useEffect(() => {
    if (!enabled || paused) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = pollMs;

    const tick = async () => {
      try {
        const data = await loadRef.current(controller.signal);
        if (controller.signal.aborted) return;
        setState({ key, data, error: undefined });
        delay = pollMs;
      } catch (error) {
        if (controller.signal.aborted || isAbort(error)) return;
        const err = error instanceof Error ? error : new Error(String(error));
        setState((prev) => ({ key, data: prev.key === key ? prev.data : undefined, error: err }));
        if (delay !== undefined) delay = Math.min(delay * 2, maxBackoffMs);
      }
      if (delay !== undefined) timer = setTimeout(() => void tick(), delay);
    };

    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, enabled, paused, pollMs, maxBackoffMs, reloads]);

  const reload = useCallback(() => {
    setReloads((n) => n + 1);
  }, []);

  const current = state.key === key;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: enabled && !current,
    reload,
  };
}

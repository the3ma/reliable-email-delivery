import { useCallback, useEffect, useState } from 'react';

/** Sets `document.title` for the current page. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Delivery Console`;
  }, [title]);
}

export interface CursorPager {
  cursor: string | undefined;
  page: number;
  next: (cursor: string) => void;
  previous: () => void;
}

/**
 * Forward-only API cursors made two-way: remembers the cursors of visited pages. Changing
 * `resetKey` (e.g. the active filters) starts again at page 1 without an effect.
 */
export function useCursorPager(resetKey: string): CursorPager {
  const [state, setState] = useState<{ key: string; stack: string[] }>({
    key: resetKey,
    stack: [],
  });
  const stack = state.key === resetKey ? state.stack : [];

  const next = useCallback(
    (cursor: string) => {
      setState((prev) => ({
        key: resetKey,
        stack: [...(prev.key === resetKey ? prev.stack : []), cursor],
      }));
    },
    [resetKey],
  );
  const previous = useCallback(() => {
    setState((prev) => ({
      key: resetKey,
      stack: (prev.key === resetKey ? prev.stack : []).slice(0, -1),
    }));
  }, [resetKey]);

  return { cursor: stack[stack.length - 1], page: stack.length + 1, next, previous };
}

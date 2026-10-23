import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => {
    document.removeEventListener('visibilitychange', onChange);
  };
}

const isVisible = () => document.visibilityState !== 'hidden';

/** True while the document is visible; flips on `visibilitychange`. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, isVisible, () => true);
}

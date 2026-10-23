import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Modal focus handling: while mounted, focus moves into `ref` (the element marked
 * `data-autofocus`, else the container), Tab / Shift+Tab cycle inside it, Escape calls `onEscape`,
 * and on unmount focus returns to whatever had it before (the trigger), if it is still in the page.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, onEscape: () => void): void {
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const initial = container.querySelector<HTMLElement>('[data-autofocus]') ?? container;
    initial.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables(container);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      if (previous?.isConnected) previous.focus();
    };
  }, [ref]);
}

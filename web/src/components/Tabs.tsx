import { useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from '../lib/cx';
import styles from './Tabs.module.css';

export interface TabItem<K extends string> {
  key: K;
  label: string;
  content: ReactNode;
}

interface TabsProps<K extends string> {
  label: string;
  tabs: readonly TabItem<K>[];
  selected: K;
  onSelect: (key: K) => void;
}

/** WAI-ARIA tabs: arrow keys / Home / End move between tabs (automatic activation). */
export function Tabs<K extends string>({ label, tabs, selected, onSelect }: TabsProps<K>) {
  const baseId = useId();
  const refs = useRef(new Map<K, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.key === selected);
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    onSelect(tab.key);
    refs.current.get(tab.key)?.focus();
  };

  const active = tabs.find((tab) => tab.key === selected);

  return (
    <div className={styles.tabs}>
      <div role="tablist" aria-label={label} className={styles.list} onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
          const isSelected = tab.key === selected;
          return (
            <button
              key={tab.key}
              ref={(el) => {
                if (el) refs.current.set(tab.key, el);
                else refs.current.delete(tab.key);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.key}`}
              aria-selected={isSelected}
              aria-controls={`${baseId}-panel-${tab.key}`}
              tabIndex={isSelected ? 0 : -1}
              className={cx(styles.tab, isSelected && styles.selected)}
              onClick={() => {
                onSelect(tab.key);
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {active ? (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${active.key}`}
          aria-labelledby={`${baseId}-tab-${active.key}`}
          className={styles.panel}
        >
          {active.content}
        </div>
      ) : null}
    </div>
  );
}

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

export interface PollingConfig {
  /** Delay between polls while requests succeed. */
  intervalMs: number;
  /** Cap for the doubling back-off after consecutive failures. */
  maxMs: number;
}

export const DEFAULT_POLLING: PollingConfig = { intervalMs: 2_000, maxMs: 30_000 };

const PollingContext = createContext<PollingConfig>(DEFAULT_POLLING);

export function PollingProvider({
  value,
  children,
}: {
  value: PollingConfig;
  children: ReactNode;
}) {
  return <PollingContext value={value}>{children}</PollingContext>;
}

export function usePollingConfig(): PollingConfig {
  return useContext(PollingContext);
}

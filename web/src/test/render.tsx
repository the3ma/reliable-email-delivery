import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { App } from '../App';

interface Options {
  route?: string;
  /** Poll delay; long by default so tests only see the polls they wait for. */
  intervalMs?: number;
}

/** Renders the whole app (layout + routes) at `route`. */
export function renderApp({ route = '/', intervalMs = 60_000 }: Options = {}) {
  const user = userEvent.setup();
  const utils = render(
    <MemoryRouter initialEntries={[route]}>
      <App polling={{ intervalMs, maxMs: intervalMs * 4 }} />
    </MemoryRouter>,
  );
  return { user, ...utils };
}

export const API = 'http://localhost:3000/api/v1';

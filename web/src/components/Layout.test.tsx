import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../mocks/server';
import { renderApp } from '../test/render';

describe('Layout', () => {
  it('has landmarks, a skip link to main and a marked current page', async () => {
    const { user } = renderApp({ route: '/mailbox' });
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Mailbox' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute('href', '#main');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(await screen.findByRole('heading', { level: 1, name: 'Mailbox' })).toBeInTheDocument();
  });

  it('reports stack health in text', async () => {
    renderApp();
    expect(await screen.findByText('Local stack: up')).toBeInTheDocument();
  });

  it('names the failing dependency from a 503 health response', async () => {
    server.use(
      http.get('*/api/v1/health', () =>
        HttpResponse.json(
          { status: 'degraded', checks: { localstack: 'ok', mailpit: 'down' } },
          { status: 503 },
        ),
      ),
    );
    renderApp();
    expect(await screen.findByText('Local stack: mailpit down')).toBeInTheDocument();
  });

  it('renders a not-found page for unknown routes', () => {
    renderApp({ route: '/nope' });
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
  });
});

import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { db } from '../mocks/db';
import { server } from '../mocks/server';
import { renderApp } from '../test/render';
import { spyOn } from '../test/spy';

describe('Scenarios', () => {
  it('lists every scenario with its expected outcome', async () => {
    renderApp({ route: '/scenarios' });
    const card = await screen.findByRole('article', { name: 'Duplicate storm' });
    expect(within(card).getByText(/Exactly 10 e-mails/)).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(8);
  });

  it('runs a scenario and shows the observed counters next to the expected ones', async () => {
    const runs = spyOn('post', '/scenarios/burst/run');
    const { user } = renderApp({ route: '/scenarios', intervalMs: 10 });
    const card = await screen.findByRole('article', { name: 'Burst' });

    await user.click(within(card).getByRole('button', { name: 'Run scenario' }));

    const progress = within(card).getByRole('status');
    expect(progress).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => {
      expect(progress).toHaveTextContent(/^Settled/);
    });
    expect(runs).toHaveLength(1);
    expect(progress).toHaveTextContent('E-mails in the Mailbox +50');

    const observed = within(card).getByRole('region', { name: /Observed result of run run-/ });
    const row = within(observed).getByRole('row', { name: /E-mails in the Mailbox/ });
    expect(row).toHaveTextContent('+50');
    expect(within(observed).getByRole('row', { name: /Messages in DLQs/ })).toHaveTextContent(
      'no change',
    );
    expect(within(card).getByRole('button', { name: 'Run again' })).toBeEnabled();
  });

  it('blocks other runs while one is in progress', async () => {
    const { user } = renderApp({ route: '/scenarios', intervalMs: 50 });
    const burst = await screen.findByRole('article', { name: 'Burst' });
    await user.click(within(burst).getByRole('button', { name: 'Run scenario' }));

    const other = screen.getByRole('article', { name: 'Invalid requests' });
    expect(within(other).getByRole('button', { name: 'Run scenario' })).toBeDisabled();
    expect(within(other).getByText('Another scenario is running.')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(other).getByRole('button', { name: 'Run scenario' })).toBeEnabled();
    });
  });

  it('reports a failed run', async () => {
    server.use(
      http.post('*/api/v1/scenarios/:id/run', () =>
        HttpResponse.json(
          { error: { code: 'publish_failed', message: 'EventBridge rejected the batch.' } },
          { status: 502 },
        ),
      ),
    );
    const { user } = renderApp({ route: '/scenarios', intervalMs: 10 });
    const card = await screen.findByRole('article', { name: 'Bounce' });
    await user.click(within(card).getByRole('button', { name: 'Run scenario' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent(
      'Run failed: EventBridge rejected the batch.',
    );
  });

  it('keeps watching while the server reports the run as running and shows its notes', async () => {
    let checks = 0;
    server.use(
      http.get('*/api/v1/scenarios/runs/:runId', ({ params }) => {
        checks += 1;
        const run = db.runStatus(String(params.runId));
        if (!run)
          return HttpResponse.json({ error: { code: 'not_found', message: 'x' } }, { status: 404 });
        return HttpResponse.json(
          checks < 4
            ? { ...run, status: 'running', notes: [...run.notes, 'send-emails = disabled'] }
            : { ...run, notes: [...run.notes, 'send-emails restored to enabled'] },
        );
      }),
    );
    const { user } = renderApp({ route: '/scenarios', intervalMs: 10 });
    const card = await screen.findByRole('article', { name: 'Kill switch' });
    await user.click(within(card).getByRole('button', { name: 'Run scenario' }));

    const progress = within(card).getByRole('status');
    await waitFor(() => {
      expect(progress).toHaveTextContent(/still working/);
    });
    await waitFor(() => {
      expect(progress).toHaveTextContent(/^Settled/);
    });
    expect(checks).toBeGreaterThanOrEqual(5); // 3 "running" + 2 quiet checks after "done"
    expect(within(card).getByText('send-emails restored to enabled')).toBeInTheDocument();
    expect(progress).toHaveTextContent('Skipped (disabled) +10');
  });

  it('explains a 409 run_in_progress', async () => {
    server.use(
      http.post('*/api/v1/scenarios/:id/run', () =>
        HttpResponse.json(
          { error: { code: 'run_in_progress', message: 'kill-switch is still running' } },
          { status: 409 },
        ),
      ),
    );
    const { user } = renderApp({ route: '/scenarios', intervalMs: 10 });
    const card = await screen.findByRole('article', { name: 'Burst' });
    await user.click(within(card).getByRole('button', { name: 'Run scenario' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent(
      'A scenario is already running.',
    );
  });
});

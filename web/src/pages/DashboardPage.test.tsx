import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { db } from '../mocks/db';
import { server } from '../mocks/server';
import { renderApp } from '../test/render';
import { spyOn } from '../test/spy';

describe('Dashboard', () => {
  it('renders the status counters from /overview', async () => {
    renderApp();
    const counts = await screen.findByRole('region', { name: 'Deliveries by state' });
    const overview = db.overview();

    const sent = within(counts).getByRole('link', {
      name: `Sent: ${String(overview.counts.SENT)} - accepted by the mail transport`,
    });
    expect(sent).toHaveAttribute('href', '/deliveries?status=SENT');
    expect(within(counts).getByRole('link', { name: /^Ambiguous: / })).toHaveTextContent(
      String(overview.counts.AMBIGUOUS),
    );

    const skipped = screen.getByRole('region', { name: 'Skipped by reason' });
    expect(within(skipped).getByText('Suppressed').nextElementSibling).toHaveTextContent(
      String(overview.skippedByReason.suppressed),
    );
    expect(within(skipped).getByText('Disabled').nextElementSibling).toHaveTextContent(
      String(overview.skippedByReason.disabled),
    );

    expect(within(skipped).getByText('Invalid: html too large')).toBeInTheDocument();

    const totals = screen.getByRole('region', { name: 'Totals' });
    expect(within(totals).getByText('Subscriptions').nextElementSibling).toHaveTextContent('20');
  });

  it('asks for confirmation before turning the kill switch off, then calls PUT', async () => {
    const calls = spyOn('put', '/toggles/send-emails');
    const { user } = renderApp();
    const card = await screen.findByRole('region', { name: 'Kill switch' });
    expect(within(card).getByText('Enabled')).toBeInTheDocument();

    const trigger = within(card).getByRole('button', { name: 'Disable sending…' });
    await user.click(trigger);
    const dialog = screen.getByRole('alertdialog', { name: 'Disable sending e-mails?' });
    expect(calls).toHaveLength(0);
    // Safe default: the focused button is Cancel.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: 'Disable sending' }));

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.body).toEqual({ value: 'disabled' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await within(card).findByText('Disabled')).toBeInTheDocument();
    expect(within(card).getByText(/Sending is now disabled/)).toBeInTheDocument();
    expect(db.toggles().sendEmails).toBe('disabled');
  });

  it('does not change the toggle when the confirmation is cancelled (Escape)', async () => {
    const calls = spyOn('put', '/toggles/send-emails');
    const { user } = renderApp();
    const trigger = await screen.findByRole('button', { name: 'Disable sending…' });
    await user.click(trigger);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(calls).toHaveLength(0);
    expect(db.toggles().sendEmails).toBe('enabled');
  });

  it('flags a dead-letter queue with messages in text, not only colour', async () => {
    server.use(
      http.get('*/api/v1/overview', () => {
        const o = db.overview();
        return HttpResponse.json({
          ...o,
          queues: { ...o.queues, emailDlq: { visible: 3, inFlight: 0 } },
        });
      }),
    );
    renderApp();
    const queues = await screen.findByRole('region', { name: 'Queues' });
    const row = within(queues).getByRole('rowheader', { name: /Email DLQ/ });
    expect(row).toHaveTextContent('needs attention');
  });

  it('shows an error state with retry when the API fails', async () => {
    server.use(
      http.get('*/api/v1/overview', () =>
        HttpResponse.json(
          { error: { code: 'upstream_unavailable', message: 'LocalStack is not reachable.' } },
          { status: 503 },
        ),
      ),
    );
    const { user } = renderApp();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('LocalStack is not reachable.');

    server.resetHandlers();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Deliveries by state' })).toBeInTheDocument();
  });
});

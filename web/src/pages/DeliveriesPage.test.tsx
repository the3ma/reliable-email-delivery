import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { db } from '../mocks/db';
import { server } from '../mocks/server';
import { renderApp } from '../test/render';
import { spyOn } from '../test/spy';

const rows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);

describe('Deliveries', () => {
  it('filters by status chip and sends the filter to the API', async () => {
    const calls = spyOn('get', '/deliveries');
    const { user } = renderApp({ route: '/deliveries' });
    await screen.findByRole('table');
    expect(rows()).toHaveLength(db.deliveries().length);

    const chip = screen.getByRole('button', { name: 'Ambiguous' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await user.click(chip);

    await waitFor(() => {
      expect(rows()).toHaveLength(1);
    });
    expect(screen.getByRole('button', { name: /Ambiguous/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(rows()[0]).toHaveTextContent('Ambiguous');
    expect(calls.at(-1)?.url.searchParams.get('status')).toBe('AMBIGUOUS');

    await user.selectOptions(screen.getByLabelText('Kind'), 'digest');
    expect(await screen.findByText('No deliveries match')).toBeInTheDocument();
    expect(calls.at(-1)?.url.searchParams.get('kind')).toBe('digest');
  });

  it('opens the drawer with the state timeline, closes on Escape and returns focus', async () => {
    const { user } = renderApp({ route: '/deliveries?status=SENT' });
    await screen.findByRole('table');
    const sent = db.deliveries().find((d) => d.status === 'SENT');
    if (!sent) throw new Error('fixture without a SENT delivery');
    const trigger = screen.getByRole('link', {
      name: new RegExp(`^Delivery ${sent.deliveryId.slice(0, 8)}.*open details`),
    });

    await user.click(trigger);

    const drawer = await screen.findByRole('dialog', { name: /^Delivery / });
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    expect(await within(drawer).findByText(sent.deliveryId)).toBeInTheDocument();
    const timeline = within(drawer).getByRole('list');
    const steps = within(timeline).getAllByRole('listitem');
    expect(steps.map((li) => li.querySelector('strong')?.textContent)).toEqual([
      'Claimed',
      'Sent',
      'Delivered',
    ]);
    expect(within(drawer).getByRole('link', { name: 'Open in the Mailbox' })).toHaveAttribute(
      'href',
      `/mailbox/${String(sent.mailId)}`,
    );
    expect(drawer.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps keyboard focus inside the drawer and closes with the Close button', async () => {
    const ambiguous = db.deliveries().find((d) => d.status === 'AMBIGUOUS');
    if (!ambiguous) throw new Error('fixture without an AMBIGUOUS delivery');
    const { user } = renderApp({ route: `/deliveries/${ambiguous.deliveryId}` });
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText(/never resent automatically/)).toBeInTheDocument();

    const close = within(drawer).getByRole('button', { name: 'Close' });
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(drawer.contains(document.activeElement)).toBe(true);
    }
    await user.click(close);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('pages with the API cursor', async () => {
    const { user } = renderApp({ route: '/deliveries?limit=25' });
    await screen.findByRole('table');
    expect(rows()).toHaveLength(25);
    expect(screen.getByRole('button', { name: '← Newer' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Older →' }));
    await waitFor(() => {
      expect(rows()).toHaveLength(db.deliveries().length - 25);
    });
    expect(screen.getByText('Page 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Older →' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '← Newer' }));
    await waitFor(() => {
      expect(rows()).toHaveLength(25);
    });
  });

  it('shows the error state when the list fails', async () => {
    server.use(
      http.get('*/api/v1/deliveries', () =>
        HttpResponse.json(
          { error: { code: 'internal', message: 'Scan failed.' } },
          { status: 500 },
        ),
      ),
    );
    renderApp({ route: '/deliveries' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Scan failed.');
  });

  it('renders legacy list items whose category, kind, user and recipient are null', async () => {
    const legacy = db.deliveries().find((d) => d.category === null);
    if (!legacy) throw new Error('fixture without a legacy record');
    renderApp({ route: '/deliveries' });
    const link = await screen.findByRole('link', {
      name: new RegExp(`^Delivery ${legacy.deliveryId.slice(0, 8)}`),
    });
    const row = link.closest('tr');
    expect(row).toHaveTextContent('Unknown');
    expect(row).toHaveTextContent('unknown');
  });
});

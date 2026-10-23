import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { db } from '../mocks/db';
import { renderApp } from '../test/render';
import { spyOn } from '../test/spy';

describe('Suppressions', () => {
  it('lists hashes only, shortened, with a copy button', async () => {
    renderApp({ route: '/suppressions' });
    const table = await screen.findByRole('table');
    const entry = db.suppressions()[0];
    if (!entry) throw new Error('no seeded suppressions');
    expect(within(table).getAllByRole('row')).toHaveLength(db.suppressions().length + 1);
    expect(within(table).getByTitle(entry.emailHash)).toHaveTextContent(
      `${entry.emailHash.slice(0, 10)}…`,
    );
    expect(within(table).getAllByRole('button', { name: 'Copy address hash' })).toHaveLength(
      db.suppressions().length,
    );
    expect(table).not.toHaveTextContent('@');
  });

  it('rejects addresses outside example.test without calling the API', async () => {
    const calls = spyOn('post', '/feedback');
    const { user } = renderApp({ route: '/suppressions' });
    const input = await screen.findByLabelText('Recipient address');

    await user.type(input, 'someone@elsewhere.invalid');
    await user.click(screen.getByRole('button', { name: 'Simulate event' }));

    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/ending in @example\.test/);
    expect(input).toHaveFocus();
    expect(calls).toHaveLength(0);

    await user.clear(input);
    await user.type(input, 'ada@example.test.evil');
    await user.click(screen.getByRole('button', { name: 'Simulate event' }));
    expect(calls).toHaveLength(0);
  });

  it('simulates a permanent bounce and shows the new suppression', async () => {
    const calls = spyOn('post', '/feedback');
    const before = db.suppressions().length;
    const { user } = renderApp({ route: '/suppressions' });
    await screen.findByRole('table');

    await user.type(screen.getByLabelText('Recipient address'), 'Ada@example.test');
    await user.click(screen.getByRole('button', { name: 'Simulate event' }));

    expect(
      await screen.findByText('Bounce recorded: the address is now suppressed.'),
    ).toBeVisible();
    expect(calls[0]?.body).toEqual({ type: 'bounce', email: 'Ada@example.test' });
    await waitFor(() => {
      expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(before + 2);
    });
  });

  it('sends transient bounces as not suppressing', async () => {
    const calls = spyOn('post', '/feedback');
    const { user } = renderApp({ route: '/suppressions' });
    await user.type(await screen.findByLabelText('Recipient address'), 'ben@example.test');
    await user.click(screen.getByRole('checkbox', { name: /Transient bounce/ }));
    await user.click(screen.getByRole('button', { name: 'Simulate event' }));

    expect(
      await screen.findByText('Bounce recorded: the address is not suppressed.'),
    ).toBeInTheDocument();
    expect(calls[0]?.body).toEqual({ type: 'bounce', email: 'ben@example.test', transient: true });
  });

  it('shows the empty state', async () => {
    db.reset({ seed: false });
    renderApp({ route: '/suppressions' });
    expect(await screen.findByText('Nothing is suppressed')).toBeInTheDocument();
  });
});

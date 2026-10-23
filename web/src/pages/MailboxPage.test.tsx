import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { db } from '../mocks/db';
import { EMAIL_CSP } from '../lib/srcdoc';
import { renderApp } from '../test/render';

function trackingMail() {
  const mail = db.mails().find((m) => m.html.includes('<script>'));
  if (!mail) throw new Error('fixture without the tracking e-mail');
  return mail;
}

describe('Mailbox', () => {
  it('lists e-mails and shows an empty preview until one is chosen', async () => {
    renderApp({ route: '/mailbox' });
    const inbox = await screen.findByRole('region', { name: 'Inbox' });
    const first = db.mails()[0];
    if (!first) throw new Error('no mails');
    expect(await within(inbox).findAllByRole('link')).toHaveLength(Math.min(db.mails().length, 25));
    expect(within(inbox).getAllByText(first.subject).length).toBeGreaterThan(0);
    expect(screen.getByText('No e-mail selected')).toBeInTheDocument();
  });

  // jsdom does not load srcdoc documents, so this pins the contract (empty sandbox, CSP first,
  // markup never in the console DOM, no side effects); browsers enforce the sandbox itself.
  it('renders HTML only inside an empty-sandbox iframe with a blocking CSP', async () => {
    const mail = trackingMail();
    const posted = vi.fn();
    window.addEventListener('message', posted);

    const { container } = renderApp({ route: `/mailbox/${mail.id}` });
    const frame = await screen.findByTitle(`HTML body of "${mail.subject}"`);

    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcdoc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(
      true,
    );
    expect(srcdoc).toContain(EMAIL_CSP.replace(/"/g, '&quot;'));
    // The e-mail markup is never parsed into the console's own DOM.
    expect(container.ownerDocument.querySelector('script:not([src])')).toBeNull();
    expect(container.ownerDocument.querySelector('img[src*="example.test"]')).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posted).not.toHaveBeenCalled();
    expect(document.title).not.toBe('pwned');
    window.removeEventListener('message', posted);
  });

  it('switches between the HTML, Text and Headers tabs with the keyboard', async () => {
    const mail = trackingMail();
    const { user } = renderApp({ route: `/mailbox/${mail.id}` });
    const htmlTab = await screen.findByRole('tab', { name: 'HTML' });
    expect(htmlTab).toHaveAttribute('aria-selected', 'true');

    await user.click(htmlTab);
    await user.keyboard('{ArrowRight}');
    const textTab = screen.getByRole('tab', { name: 'Text' });
    expect(textTab).toHaveAttribute('aria-selected', 'true');
    expect(textTab).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('is ready');
    expect(screen.queryByTitle(/HTML body/)).not.toBeInTheDocument();

    await user.keyboard('{End}');
    const panel = screen.getByRole('tabpanel', { name: 'Headers' });
    const deliveryId = mail.deliveryId ?? '';
    expect(within(panel).getByRole('link', { name: deliveryId })).toHaveAttribute(
      'href',
      `/deliveries/${deliveryId}`,
    );
  });

  it('links the deliveryId to its delivery drawer', async () => {
    const mail = trackingMail();
    const { user } = renderApp({ route: `/mailbox/${mail.id}` });
    const link = await screen.findByRole('link', { name: /open the delivery/ });
    await user.click(link);
    const drawer = await screen.findByRole('dialog', { name: /^Delivery / });
    expect(await within(drawer).findByText(mail.deliveryId ?? '')).toBeInTheDocument();
  });

  it('shows an empty state when the inbox is empty', async () => {
    db.reset({ seed: false });
    renderApp({ route: '/mailbox' });
    expect(await screen.findByText('The inbox is empty')).toBeInTheDocument();
  });
});

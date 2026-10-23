import { Link, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { DEFAULT_POLLING, PollingProvider } from './lib/polling';
import type { PollingConfig } from './lib/polling';
import { usePageTitle } from './lib/hooks';
import { DashboardPage } from './pages/DashboardPage';
import { DeliveriesPage } from './pages/DeliveriesPage';
import { MailboxPage } from './pages/MailboxPage';
import { ScenariosPage } from './pages/ScenariosPage';
import { SuppressionsPage } from './pages/SuppressionsPage';

function NotFoundPage() {
  usePageTitle('Not found');
  return (
    <>
      <h1>Page not found</h1>
      <p>
        There is nothing at this address. <Link to="/">Go to the dashboard</Link>.
      </p>
    </>
  );
}

export function App({ polling = DEFAULT_POLLING }: { polling?: PollingConfig }) {
  return (
    <PollingProvider value={polling}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="scenarios" element={<ScenariosPage />} />
          {/* One route with an optional id keeps the list mounted while the drawer opens. */}
          <Route path="deliveries/:deliveryId?" element={<DeliveriesPage />} />
          <Route path="mailbox/:mailId?" element={<MailboxPage />} />
          <Route path="suppressions" element={<SuppressionsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </PollingProvider>
  );
}

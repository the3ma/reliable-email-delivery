import { NavLink, Outlet } from 'react-router';
import { api } from '../api/endpoints';
import { useResource } from '../lib/useResource';
import { cx } from '../lib/cx';
import styles from './Layout.module.css';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/scenarios', label: 'Scenarios', end: false },
  { to: '/deliveries', label: 'Deliveries', end: false },
  { to: '/mailbox', label: 'Mailbox', end: false },
  { to: '/suppressions', label: 'Suppressions', end: false },
] as const;

function HealthBadge() {
  const health = useResource('health', (signal) => api.health(signal), { pollMs: 15_000 });
  let label = 'Checking stack…';
  let tone = styles.healthUnknown;
  if (health.data) {
    const down = Object.entries(health.data.checks)
      .filter(([, value]) => value !== 'ok')
      .map(([name]) => name);
    if (down.length === 0) {
      label = 'Local stack: up';
      tone = styles.healthOk;
    } else {
      label = `Local stack: ${down.join(', ')} down`;
      tone = styles.healthDown;
    }
  } else if (health.error) {
    label = 'Console API: unreachable';
    tone = styles.healthDown;
  }
  return (
    <p className={cx(styles.health, tone)} role="status">
      <span className={styles.healthDot} aria-hidden="true" />
      {label}
    </p>
  );
}

export function Layout() {
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main">
        Skip to main content
      </a>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <NavLink to="/" className={cx(styles.brand)} aria-label="Delivery Console, dashboard">
            <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
              <rect width="32" height="32" rx="7" fill="currentColor" />
              <path
                d="M7 10h18v12H7zM7 11l9 7 9-7"
                fill="none"
                stroke="var(--surface)"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            </svg>
            <span>Delivery Console</span>
          </NavLink>
          <HealthBadge />
        </div>
        <nav aria-label="Main" className={styles.nav}>
          <ul>
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => cx(styles.navLink, isActive && styles.active)}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" tabIndex={-1} className={styles.main}>
        <Outlet />
      </main>
      <footer className={styles.footer}>
        <p>
          Local demo only - LocalStack + Mailpit. Recipient addresses are masked everywhere except
          the Mailbox of fake <code>example.test</code> users.
        </p>
      </footer>
    </div>
  );
}

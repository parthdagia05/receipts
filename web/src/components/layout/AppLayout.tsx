import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { ConnectPrompt, Topbar } from './Topbar';
import styles from './layout.module.css';

const COLLAPSE_KEY = 'receipts.sidebar.collapsed';

/**
 * The application shell.
 *
 * The collapsed state persists across visits because it is a workspace
 * preference, not transient UI state. On narrow viewports the rail becomes a
 * drawer instead, so the collapsed/expanded distinction does not apply there.
 */
export function AppLayout() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, String(collapsed));
    } catch {
      /* Private browsing; the preference simply does not persist. */
    }
  }, [collapsed]);

  // A route change always closes the drawer, and returns focus to the top of
  // the new page rather than leaving the viewport mid-document.
  useEffect(() => {
    setMobileOpen(false);
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className={[styles.shell, collapsed ? styles.shellCollapsed : ''].join(' ')}>
      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        onNavigate={() => setMobileOpen(false)}
      />

      {mobileOpen && (
        <div className={styles.scrim} onClick={() => setMobileOpen(false)} aria-hidden="true" />
      )}

      <div className={styles.main}>
        <Topbar onOpenMenu={() => setMobileOpen(true)} />
        <ConnectPrompt />
        <main className={styles.content}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

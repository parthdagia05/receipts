import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { TourProvider, useTour } from '../../tour/TourProvider';
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
 *
 * The product tour lives at this level because it spans pages: the provider
 * needs the router context, and the sidebar needs the tour context.
 */
export function AppLayout() {
  return (
    <TourProvider>
      <AppShell />
    </TourProvider>
  );
}

function AppShell() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const { tourActive } = useTour();
  // Read through a ref so a tour ending does not re-run the scroll effect.
  const tourActiveRef = useRef(false);
  tourActiveRef.current = tourActive;

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, String(collapsed));
    } catch {
      /* Private browsing; the preference simply does not persist. */
    }
  }, [collapsed]);

  // A route change always closes the drawer, and returns focus to the top of
  // the new page rather than leaving the viewport mid-document — unless the
  // tour caused the navigation, in which case it scrolls its own target into
  // view and a scroll-to-top here would fight it.
  useEffect(() => {
    setMobileOpen(false);
    if (!tourActiveRef.current) window.scrollTo({ top: 0 });
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

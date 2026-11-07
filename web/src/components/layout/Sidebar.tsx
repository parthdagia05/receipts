import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useTour } from '../../tour/TourProvider';
import { Logo, Wordmark } from '../Logo';
import {
  AgentsIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DashboardIcon,
  DocsIcon,
  ExploreIcon,
  ReviewsIcon,
  ShieldIcon,
  TourIcon,
} from '../ui/Icons';
import styles from './layout.module.css';

/**
 * Primary navigation.
 *
 * Five destinations in three groups, and nothing that is not a real page.
 * Every item here routes somewhere implemented — a navigation entry that leads
 * to a stub is worse than no entry at all.
 */

interface NavEntry {
  readonly to: string;
  readonly label: string;
  readonly icon: ReactNode;
  /** Exact matching for index routes, so `/` is not active on every page. */
  readonly end?: boolean;
}

const GROUPS: readonly { readonly label: string; readonly items: readonly NavEntry[] }[] = [
  {
    label: 'Overview',
    items: [{ to: '/', label: 'Dashboard', icon: <DashboardIcon size={17} />, end: true }],
  },
  {
    label: 'Platform',
    items: [
      { to: '/agents', label: 'Explore Agents', icon: <ExploreIcon size={17} /> },
      { to: '/reviews', label: 'Reviews', icon: <ReviewsIcon size={17} /> },
    ],
  },
  {
    label: 'Developer',
    items: [
      { to: '/my-agents', label: 'My Agents', icon: <AgentsIcon size={17} /> },
      { to: '/demo', label: 'Attack Demo', icon: <ShieldIcon size={17} /> },
      { to: '/docs', label: 'Documentation', icon: <DocsIcon size={17} /> },
    ],
  },
];

export function Sidebar({
  collapsed,
  mobileOpen,
  onToggleCollapsed,
  onNavigate,
}: {
  collapsed: boolean;
  mobileOpen: boolean;
  onToggleCollapsed: () => void;
  onNavigate: () => void;
}) {
  const { startTour } = useTour();

  return (
    <aside
      className={[
        styles.sidebar,
        collapsed ? styles.collapsed : '',
        mobileOpen ? styles.sidebarOpen : '',
      ].join(' ')}
    >
      <div className={styles.brand}>
        <NavLink to="/" onClick={onNavigate} aria-label="Receipts home">
          {collapsed ? <Logo size={28} /> : <Wordmark size={28} />}
        </NavLink>
      </div>

      <nav className={styles.nav}>
        {GROUPS.map((group) => (
          <div key={group.label} className={styles.navGroup}>
            <div className={styles.navGroupLabel}>{group.label}</div>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end === true}
                onClick={onNavigate}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) =>
                  [styles.navItem, isActive ? styles.navItemActive : ''].join(' ')
                }
              >
                <span className={styles.navIcon}>{item.icon}</span>
                <span className={styles.navLabel}>{item.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className={styles.sidebarFooter}>
        <button
          type="button"
          className={styles.collapseButton}
          onClick={() => {
            onNavigate();
            startTour();
          }}
          title="Replay the product tour"
        >
          <TourIcon size={16} />
          <span className={styles.navLabel}>Product tour</span>
        </button>
        <button
          type="button"
          className={[styles.collapseButton, styles.desktopOnly].join(' ')}
          onClick={onToggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRightIcon size={16} /> : <ChevronLeftIcon size={16} />}
          <span className={styles.navLabel}>Collapse</span>
        </button>
      </div>
    </aside>
  );
}

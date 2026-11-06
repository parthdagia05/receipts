import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AgentTable, AgentTableSkeleton } from '../components/AgentTable';
import { Button, Card, CardHeader, EmptyState } from '../components/ui';
import { ExploreIcon, SearchIcon } from '../components/ui/Icons';
import { useAsync } from '../hooks/useAsync';
import { findHighestAgentId, loadAgents } from '../lib/agents';
import { formatCount } from '../lib/format';
import styles from './pages.module.css';
import ui from '../components/ui/ui.module.css';

const PAGE_SIZE = 14;

/**
 * Agent directory.
 *
 * The registry offers no enumeration and no name index, so this lists agents
 * by descending id — newest first — and pages backwards. Search is by id,
 * because that is the only key the contract can answer on; a free-text box
 * over data that does not exist would be worse than offering less.
 */
export function ExploreAgents() {
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  const highest = useAsync(() => findHighestAgentId(), []);

  const pageIds = useMemo(() => {
    if (highest.data === null || highest.data === 0n) return [];
    const start = highest.data - BigInt(page * PAGE_SIZE);
    const ids: bigint[] = [];
    for (let id = start; id > 0n && ids.length < PAGE_SIZE; id--) ids.push(id);
    return ids;
  }, [highest.data, page]);

  const agents = useAsync(() => loadAgents(pageIds), [pageIds], { enabled: pageIds.length > 0 });

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const id = query.trim().replace(/^#/, '');
    if (!/^\d+$/.test(id) || id === '0') return;
    navigate(`/agents/${id}`);
  };

  const total = highest.data ?? 0n;
  const lastPage = total === 0n ? 0 : Math.ceil(Number(total) / PAGE_SIZE) - 1;

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>
            Agents <span className={styles.pageTitleMuted}>· Directory</span>
          </h1>
          <p className={styles.pageSubtitle}>
            {highest.data !== null && highest.data > 0n
              ? `${formatCount(highest.data)} agents registered in the ERC-8004 Identity Registry, newest first.`
              : 'Agents registered in the ERC-8004 Identity Registry, newest first.'}
          </p>
        </div>
        <form onSubmit={submitSearch} className={styles.pageActions} role="search">
          <div style={{ position: 'relative' }}>
            <SearchIcon
              size={14}
              style={{
                position: 'absolute',
                left: 11,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-muted)',
                pointerEvents: 'none',
              }}
            />
            <input
              className={ui.input}
              style={{ paddingLeft: 32, height: 34, width: 190 }}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Agent ID…"
              inputMode="numeric"
              aria-label="Search by agent ID"
            />
          </div>
          <Button type="submit" variant="secondary" size="md">
            Go
          </Button>
        </form>
      </div>

      <Card>
        <CardHeader
          title="All agents"
          description="The Identity Registry stores no on-chain name, so agents are identified by ID."
        />

        {highest.error !== null ? (
          <EmptyState
            title="Couldn't reach the registry"
            body="The RPC endpoint didn't respond."
            action={
              <Button variant="secondary" size="sm" onClick={highest.reload}>
                Try again
              </Button>
            }
          />
        ) : highest.loading || agents.loading ? (
          <AgentTableSkeleton rows={PAGE_SIZE} />
        ) : total === 0n ? (
          <EmptyState
            icon={<ExploreIcon size={18} />}
            title="No agents registered"
            body="The Identity Registry has no minted agents on this network yet."
          />
        ) : agents.error !== null ? (
          <EmptyState
            title="Couldn't load this page"
            body="Some registry reads failed."
            action={
              <Button variant="secondary" size="sm" onClick={agents.reload}>
                Try again
              </Button>
            }
          />
        ) : (
          <>
            <AgentTable agents={agents.data ?? []} />
            <div className={styles.pager}>
              <span className={styles.pagerLabel}>
                Page {formatCount(page + 1)} of {formatCount(lastPage + 1)}
              </span>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((value) => Math.max(0, value - 1))}
                >
                  Newer
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= lastPage}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Older
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </>
  );
}

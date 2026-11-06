import { Link } from 'react-router-dom';
import type { AgentSummary } from '../lib/agents';
import { shortAddress } from '../lib/format';
import { Badge, Button, Skeleton } from './ui';
import { AgentsIcon } from './ui/Icons';
import styles from '../pages/pages.module.css';

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * An agent as a card.
 *
 * Used only where the set is small and personal — My Agents — so the grid
 * reads as "yours" rather than as a directory. The directory itself uses
 * `AgentTable`, because comparing many agents is a column-wise job.
 */
export function AgentCard({ agent }: { agent: AgentSummary }) {
  const id = agent.agentId.toString(10);
  const hasPaymentWallet = agent.agentWallet !== null && agent.agentWallet !== ZERO;

  return (
    <article className={styles.agentCard}>
      <div className={styles.agentCell}>
        <span className={[styles.swatch, styles.swatchLg].join(' ')} aria-hidden="true">
          <AgentsIcon size={18} />
        </span>
        <div style={{ minWidth: 0 }}>
          {/* The registry stores no on-chain name, so the id is the identity. */}
          <div className={styles.agentCellId}>Agent #{id}</div>
          <div className={styles.agentCellSub}>
            {agent.owner === null ? 'Owner unavailable' : `Owned by ${shortAddress(agent.owner)}`}
          </div>
        </div>
      </div>

      <div className={styles.agentRows}>
        <div className={styles.agentRow}>
          <span className={styles.agentRowLabel}>Feedback authors</span>
          <span className={styles.agentRowValue}>{agent.clientCount ?? '—'}</span>
        </div>
        <div className={styles.agentRow}>
          <span className={styles.agentRowLabel}>Payment wallet</span>
          {hasPaymentWallet ? (
            <Badge tone="success">Set</Badge>
          ) : (
            <Badge tone="neutral">Not set</Badge>
          )}
        </div>
      </div>

      <div className={styles.agentCardFoot}>
        <Link to={`/agents/${id}`} style={{ flex: 1 }}>
          <Button variant="secondary" size="sm" fullWidth>
            View details
          </Button>
        </Link>
      </div>
    </article>
  );
}

export function AgentCardSkeleton() {
  return (
    <article className={styles.agentCard} aria-hidden="true">
      <div className={styles.agentCell}>
        <span className={[styles.swatch, styles.swatchLg].join(' ')} />
        <div style={{ flex: 1 }}>
          <Skeleton height={14} width="60%" />
          <div style={{ marginTop: 6 }}>
            <Skeleton height={10} width="75%" />
          </div>
        </div>
      </div>
      <div className={styles.agentRows}>
        <Skeleton height={12} />
        <Skeleton height={12} />
      </div>
      <Skeleton height={28} />
    </article>
  );
}

import { Link } from 'react-router-dom';
import { AgentCard, AgentCardSkeleton } from '../components/AgentCard';
import { ReviewRow } from '../components/ReviewList';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Notice,
  SectionHeading,
  Skeleton,
} from '../components/ui';
import { AgentsIcon, ReviewsIcon, WalletIcon } from '../components/ui/Icons';
import { useAsync } from '../hooks/useAsync';
import { loadOwnedAgents } from '../lib/agents';
import { formatCount } from '../lib/format';
import { attachTimestamps, loadReviews } from '../lib/reviews';
import { useWallet } from '../wallet/WalletProvider';
import styles from './pages.module.css';

/**
 * The connected wallet's own footprint: agents it owns, and reviews it wrote.
 *
 * Both are derived from logs rather than from any server-side account, because
 * Receipts has no accounts — a wallet is the only identity the protocol knows.
 */
export function MyAgents() {
  const wallet = useWallet();
  const address = wallet.address;

  const owned = useAsync(
    () => (address === null ? Promise.resolve(null) : loadOwnedAgents(address)),
    [address],
    { enabled: address !== null },
  );

  const written = useAsync(
    async () =>
      address === null ? [] : attachTimestamps(await loadReviews({ reviewer: address, limit: 25 })),
    [address],
    { enabled: address !== null },
  );

  if (address === null) {
    return (
      <>
        <div className={styles.pageHead}>
          <div>
            <h1 className={styles.pageTitle}>
              My Agents <span className={styles.pageTitleMuted}>· Wallet</span>
            </h1>
            <p className={styles.pageSubtitle}>
              Agents owned by this wallet, and the reviews it has signed.
            </p>
          </div>
        </div>
        <Card>
          <EmptyState
            icon={<WalletIcon size={20} />}
            title="Connect your wallet"
            body="Receipts has no accounts. Connect a wallet to see the agents it owns and the reviews it has signed."
            action={
              <Button
                variant="primary"
                size="sm"
                loading={wallet.connecting}
                disabled={!wallet.available}
                onClick={() => void wallet.connect()}
              >
                {wallet.available ? 'Connect Wallet' : 'No wallet detected'}
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>
            My Agents <span className={styles.pageTitleMuted}>· Wallet</span>
          </h1>
          <p className={styles.pageSubtitle}>
            Agents owned by this wallet, and the reviews it has signed.
          </p>
        </div>
      </div>

      <section className={styles.stackTight}>
        <SectionHeading title="Owned agents" />
        {owned.loading ? (
          <div className={styles.agentGrid}>
            {[0, 1, 2].map((index) => (
              <AgentCardSkeleton key={index} />
            ))}
          </div>
        ) : owned.error !== null ? (
          <Card>
            <EmptyState
              title="Couldn't scan for ownership"
              body="Reading Transfer logs failed."
              action={
                <Button variant="secondary" size="sm" onClick={owned.reload}>
                  Try again
                </Button>
              }
            />
          </Card>
        ) : owned.data === null || owned.data.agents.length === 0 ? (
          <Card>
            <EmptyState
              icon={<AgentsIcon size={20} />}
              title="No agents found for this wallet"
              body={
                owned.data === null
                  ? 'Nothing to show.'
                  : `No agent transfers to this address in the last ${formatCount(
                      300_000,
                    )} blocks. Agents are registered through the ERC-8004 Identity Registry, not through Receipts.`
              }
            />
          </Card>
        ) : (
          <>
            <div className={styles.agentGrid}>
              {owned.data.agents.map((agent) => (
                <AgentCard key={agent.agentId.toString()} agent={agent} />
              ))}
            </div>
            {!owned.data.complete && (
              <Notice tone="info">
                Ownership is recovered from <code>Transfer</code> logs, scanned back to block{' '}
                {formatCount(owned.data.scannedFrom)}. Agents acquired before that will not appear
                here; open them directly by ID.
              </Notice>
            )}
          </>
        )}
      </section>

      <Card>
        <CardHeader
          title="Reviews you have written"
          description="Matched on the attested reviewer address, not on the transaction sender."
        />
        {written.loading ? (
          <div style={{ padding: 'var(--space-5)', display: 'grid', gap: 'var(--space-4)' }}>
            {[0, 1].map((row) => (
              <Skeleton key={row} height={56} />
            ))}
          </div>
        ) : written.error !== null ? (
          <EmptyState
            title="Couldn't load your reviews"
            body="Scanning for review events failed."
            action={
              <Button variant="secondary" size="sm" onClick={written.reload}>
                Try again
              </Button>
            }
          />
        ) : written.data === null || written.data.length === 0 ? (
          <EmptyState
            icon={<ReviewsIcon size={20} />}
            title="No reviews yet"
            body="Verify with World ID to review an agent you have used."
            action={
              <Link to="/agents">
                <Button variant="primary" size="sm">
                  Explore agents
                </Button>
              </Link>
            }
          />
        ) : (
          <div>
            {written.data.map((review) => (
              <ReviewRow key={review.transactionHash} review={review} />
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

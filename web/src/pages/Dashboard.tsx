import { Link } from 'react-router-dom';
import { AgentTable, AgentTableSkeleton } from '../components/AgentTable';
import { ReviewRow } from '../components/ReviewList';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DescriptionList,
  DescriptionRow,
  EmptyState,
  ExternalLink,
  Notice,
  Skeleton,
  Stat,
  StatGrid,
  Table,
} from '../components/ui';
import {
  AgentsIcon,
  ChevronRightIcon,
  ReviewsIcon,
  ShieldIcon,
  WalletIcon,
} from '../components/ui/Icons';
import { useAsync } from '../hooks/useAsync';
import { reviewGatewayAbi } from '../lib/abi';
import { findHighestAgentId, loadRecentAgents } from '../lib/agents';
import { fetchHealth } from '../lib/api';
import { publicClient } from '../lib/chain';
import { addressUrl, config } from '../lib/config';
import { formatCount, shortAddress } from '../lib/format';
import { attachTimestamps, loadReviewTotals, loadReviews } from '../lib/reviews';
import styles from './pages.module.css';

const FEATURED_AGENTS = 6;
const RECENT_REVIEWS = 3;

export function Dashboard() {
  const agents = useAsync(() => loadRecentAgents(FEATURED_AGENTS), []);
  const highestId = useAsync(() => findHighestAgentId(), []);
  const totals = useAsync(() => loadReviewTotals(), []);
  const recent = useAsync(
    async () => attachTimestamps(await loadReviews({ limit: RECENT_REVIEWS })),
    [],
  );
  const health = useAsync(() => fetchHealth(), []);

  // The gateway's own view of itself, so the panel reports what is deployed
  // rather than what this app happens to be configured with.
  const chain = useAsync(async () => {
    const [chainId, blockNumber, signer, minPayment] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlockNumber(),
      publicClient.readContract({
        address: config.reviewGateway,
        abi: reviewGatewayAbi,
        functionName: 'recordServerSigner',
      }),
      publicClient.readContract({
        address: config.reviewGateway,
        abi: reviewGatewayAbi,
        functionName: 'minPayment',
      }),
    ]);
    return { chainId, blockNumber, signer, minPayment };
  }, []);

  const serverTone = health.loading
    ? 'neutral'
    : health.error !== null
      ? 'danger'
      : health.data?.status === 'ok'
        ? 'success'
        : 'warning';

  const chainTone = chain.loading ? 'neutral' : chain.error !== null ? 'danger' : 'success';

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>
            Dashboard <span className={styles.pageTitleMuted}>· Overview</span>
          </h1>
          <p className={styles.pageSubtitle}>
            Explore AI agents and see what verified humans think about them.
          </p>
        </div>
        <div className={styles.pageActions}>
          <Link to="/agents">
            <Button variant="secondary" size="md">
              Explore agents
            </Button>
          </Link>
          <Link to="/agents">
            <Button variant="primary" size="md" icon={<ReviewsIcon size={14} />}>
              Submit a review
            </Button>
          </Link>
        </div>
      </div>

      {/* Every value below is read from chain or from the server. Nothing is
          hardcoded, and a failed read shows an em dash rather than a zero. */}
      <StatGrid>
        <Stat
          label="Highest agent ID"
          loading={highestId.loading}
          value={
            highestId.error !== null || highestId.data === null ? null : formatCount(highestId.data)
          }
          icon={<AgentsIcon size={15} />}
          /* Not a count. IDs are minted sequentially, so this is an upper
             bound on how many agents exist; any burned token would make the
             true total lower, and the registry exposes no supply to check. */
          hint="Highest ID minted; IDs are sequential, burns not subtracted"
          status={
            highestId.loading || highestId.error !== null ? undefined : (
              <Badge tone="success" dot>
                Live
              </Badge>
            )
          }
        />
        <Stat
          label="Reviews submitted"
          loading={totals.loading}
          value={
            totals.error !== null || totals.data === null ? null : formatCount(totals.data.total)
          }
          icon={<ReviewsIcon size={15} />}
          hint="ReviewSubmitted events on this gateway"
        />
        <Stat
          label="Human-verified"
          loading={totals.loading}
          value={
            totals.error !== null || totals.data === null ? null : formatCount(totals.data.free)
          }
          icon={<ShieldIcon size={15} />}
          hint="World ID proof, no payment"
        />
        <Stat
          label="Human-verified · Paid"
          loading={totals.loading}
          value={
            totals.error !== null || totals.data === null ? null : formatCount(totals.data.paid)
          }
          icon={<WalletIcon size={15} />}
          hint="World ID proof and a settled USDC receipt"
        />
        <Stat
          label="Wallet-verified"
          loading={totals.loading}
          value={
            totals.error !== null || totals.data === null ? null : formatCount(totals.data.wallet)
          }
          icon={<WalletIcon size={15} />}
          hint="Wallet signature only. Not proof of one person, not scored"
        />
      </StatGrid>

      <Card>
        <CardHeader
          title={config.chainName}
          description={`Chain ${config.chainId}`}
          action={
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <Badge tone={chainTone} dot>
                {chain.loading ? 'Checking' : chain.error !== null ? 'Unreachable' : 'Connected'}
              </Badge>
              {chain.error !== null && (
                <Button variant="secondary" size="sm" onClick={chain.reload}>
                  Retry
                </Button>
              )}
            </div>
          }
        />
        {chain.error !== null && (
          <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
            <Notice tone="danger">
              No configured RPC endpoint answered. The values below are unavailable, not zero.
            </Notice>
          </div>
        )}
        <div className={styles.chainGrid}>
          <div>
            <div className={styles.chainLabel}>Latest block</div>
            <div className={styles.chainValue}>
              {chain.data === null ? '—' : formatCount(chain.data.blockNumber)}
            </div>
          </div>
          <div>
            <div className={styles.chainLabel}>Gateway deployed at</div>
            <div className={styles.chainValue}>{formatCount(config.gatewayDeployBlock)}</div>
          </div>
          <div>
            <div className={styles.chainLabel}>Minimum payment</div>
            <div className={styles.chainValue}>
              {chain.data === null ? '—' : `${Number(chain.data.minPayment) / 1e6} USDC`}
            </div>
          </div>
          <div>
            <div className={styles.chainLabel}>ReviewGateway</div>
            <div className={styles.chainValue}>
              <ExternalLink href={addressUrl(config.reviewGateway)}>
                {shortAddress(config.reviewGateway)}
              </ExternalLink>
            </div>
          </div>
          <div>
            <div className={styles.chainLabel}>ReceiptSettler</div>
            <div className={styles.chainValue}>
              <ExternalLink href={addressUrl(config.receiptSettler)}>
                {shortAddress(config.receiptSettler)}
              </ExternalLink>
            </div>
          </div>
          <div>
            <div className={styles.chainLabel}>NullifierRegistry</div>
            <div className={styles.chainValue}>
              <ExternalLink href={addressUrl(config.nullifierRegistry)}>
                {shortAddress(config.nullifierRegistry)}
              </ExternalLink>
            </div>
          </div>
        </div>
      </Card>

      <div className={styles.split}>
        <div className={styles.splitCol}>
          <Card>
            <CardHeader
              title="Recently registered agents"
              description="Newest entries in the ERC-8004 Identity Registry"
              action={
                <Link to="/agents">
                  <Button variant="ghost" size="sm" icon={<ChevronRightIcon size={13} />}>
                    View all
                  </Button>
                </Link>
              }
            />
            {agents.loading ? (
              <AgentTableSkeleton rows={FEATURED_AGENTS} />
            ) : agents.error !== null ? (
              <EmptyState
                compact
                title="Couldn't reach the registry"
                body="The RPC endpoint didn't respond. Retry, or check VITE_RPC_URL."
                action={
                  <Button variant="secondary" size="sm" onClick={agents.reload}>
                    Try again
                  </Button>
                }
              />
            ) : agents.data === null || agents.data.length === 0 ? (
              <EmptyState
                compact
                title="No agents found"
                body="The Identity Registry has no minted agents on this network."
              />
            ) : (
              <AgentTable agents={agents.data} />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Recent review activity"
              description="From the gateway's ReviewSubmitted events"
              action={
                <Link to="/reviews">
                  <Button variant="ghost" size="sm" icon={<ChevronRightIcon size={13} />}>
                    All reviews
                  </Button>
                </Link>
              }
            />
            {recent.loading ? (
              <div style={{ padding: 'var(--space-5)', display: 'grid', gap: 'var(--space-3)' }}>
                {[0, 1].map((row) => (
                  <Skeleton key={row} height={44} />
                ))}
              </div>
            ) : recent.error !== null ? (
              <EmptyState
                compact
                title="Couldn't load reviews"
                body="The RPC endpoint didn't respond while scanning for events."
                action={
                  <Button variant="secondary" size="sm" onClick={recent.reload}>
                    Try again
                  </Button>
                }
              />
            ) : recent.data === null || recent.data.length === 0 ? (
              <EmptyState
                compact
                icon={<ReviewsIcon size={18} />}
                title="No reviews yet"
                body="Reviews appear here once they are confirmed on-chain."
                action={
                  <Link to="/agents">
                    <Button variant="primary" size="sm">
                      Submit the first review
                    </Button>
                  </Link>
                }
              />
            ) : (
              <div>
                {recent.data.map((review) => (
                  <ReviewRow key={review.transactionHash} review={review} />
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className={styles.splitCol}>
          <Card>
            <CardHeader title="System status" />
            <Table columns={['Service', 'Status']}>
              <tr>
                <td>Record Server</td>
                <td className={styles.rowAction}>
                  <Badge tone={serverTone} dot>
                    {health.loading
                      ? 'Checking'
                      : health.error !== null
                        ? 'Unreachable'
                        : health.data?.status === 'ok'
                          ? 'Healthy'
                          : 'Degraded'}
                  </Badge>
                </td>
              </tr>
              <tr>
                <td>Database</td>
                <td className={styles.rowAction}>
                  {health.data === null ? (
                    <Badge tone="neutral">Unknown</Badge>
                  ) : (
                    <Badge tone={health.data.checks.database === 'ok' ? 'success' : 'danger'} dot>
                      {health.data.checks.database === 'ok' ? 'Connected' : 'Unreachable'}
                    </Badge>
                  )}
                </td>
              </tr>
              <tr>
                <td>Sepolia RPC</td>
                <td className={styles.rowAction}>
                  <Badge tone={chainTone} dot>
                    {chain.loading
                      ? 'Checking'
                      : chain.error !== null
                        ? 'Unreachable'
                        : 'Connected'}
                  </Badge>
                </td>
              </tr>
              <tr>
                <td>Attestation signer</td>
                <td className={styles.rowAction}>
                  {chain.data === null ? (
                    <span style={{ color: 'var(--text-muted)' }}>&mdash;</span>
                  ) : (
                    <ExternalLink href={addressUrl(chain.data.signer)}>
                      {shortAddress(chain.data.signer)}
                    </ExternalLink>
                  )}
                </td>
              </tr>
            </Table>
          </Card>

          <Card>
            <CardHeader title="Registry configuration" />
            <div>
              {[
                {
                  name: 'ERC-8004 Identity',
                  address: config.identityRegistry,
                  role: 'Ownership and wallets',
                },
                {
                  name: 'ERC-8004 Reputation',
                  address: config.reputationRegistry,
                  role: 'Feedback and summaries',
                },
                {
                  name: 'Receipts Gateway',
                  address: config.reviewGateway,
                  role: 'Writes feedback for you',
                },
              ].map((entry) => (
                <div key={entry.address} className={styles.configRow}>
                  <span className={styles.configIcon}>
                    <AgentsIcon size={14} />
                  </span>
                  <div className={styles.configBody}>
                    <div className={styles.configTop}>
                      <span className={styles.configName}>{entry.name}</span>
                      <ExternalLink href={addressUrl(entry.address)}>
                        {shortAddress(entry.address, 6, 4)}
                      </ExternalLink>
                    </div>
                    <div className={styles.configMeta}>{entry.role}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

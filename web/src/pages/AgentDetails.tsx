import { Link, useParams } from 'react-router-dom';
import { ReviewRow } from '../components/ReviewList';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Copyable,
  DescriptionList,
  DescriptionRow,
  EmptyState,
  ExternalLink,
  Notice,
  Skeleton,
  Stat,
  StatGrid,
} from '../components/ui';
import { AgentsIcon, ArrowLeftIcon, ReviewsIcon } from '../components/ui/Icons';
import { ArkivRecord } from '../components/ArkivRecord';
import { EvidenceViewer } from '../components/EvidenceViewer';
import { ReputationTiers } from '../components/ReputationTiers';
import { useAsync } from '../hooks/useAsync';
import { loadAgentDetail } from '../lib/agents';
import { fetchReputation } from '../lib/api';
import { addressUrl, config } from '../lib/config';
import { formatFeedbackValue, shortAddress, shortHash } from '../lib/format';
import { attachTimestamps, loadReviews } from '../lib/reviews';
import { useWallet } from '../wallet/WalletProvider';
import styles from './pages.module.css';

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * One agent, with its reputation and its Receipts review history.
 *
 * Two aggregates are shown and kept visually distinct, because they answer
 * different questions: the registry-wide summary covers every client that has
 * ever written feedback for this agent, while the Receipts summary is
 * restricted to feedback authored by this gateway. Conflating them would
 * present other projects' ratings as ours.
 */
export function AgentDetails() {
  const { agentId: rawAgentId } = useParams<{ agentId: string }>();
  const wallet = useWallet();

  const valid = rawAgentId !== undefined && /^\d+$/.test(rawAgentId) && rawAgentId !== '0';
  const agentId = valid ? BigInt(rawAgentId) : 0n;

  const agent = useAsync(() => loadAgentDetail(agentId), [agentId], { enabled: valid });
  // The Receipts score. Served by the Record Server, which derives every
  // weight from chain data; it is not the registry mean and is deliberately
  // fetched and labelled separately.
  const reputation = useAsync(() => fetchReputation(agentId.toString(10)), [agentId], {
    enabled: valid,
  });

  const reviews = useAsync(
    async () => attachTimestamps(await loadReviews({ agentId, limit: 25 })),
    [agentId],
    { enabled: valid },
  );

  if (!valid) {
    return (
      <Card>
        <EmptyState
          title="Invalid agent ID"
          body="Agent IDs are positive whole numbers, as minted by the ERC-8004 Identity Registry."
          action={
            <Link to="/agents">
              <Button variant="secondary" size="sm">
                Back to agents
              </Button>
            </Link>
          }
        />
      </Card>
    );
  }

  const isOwner =
    wallet.address !== null &&
    agent.data?.owner != null &&
    wallet.address.toLowerCase() === agent.data.owner.toLowerCase();

  return (
    <>
      <Link to="/agents" className={styles.backLink}>
        <ArrowLeftIcon size={13} />
        All agents
      </Link>

      <div className={styles.pageHead}>
        <div className={styles.agentCell}>
          <span className={[styles.swatch, styles.swatchLg].join(' ')} aria-hidden="true">
            <AgentsIcon size={18} />
          </span>
          <div>
            <h1 className={styles.pageTitle}>
              Agent <span className={styles.pageTitleMuted}>#{agentId.toString(10)}</span>
            </h1>
            <p className={styles.pageSubtitle}>
              Identity and reputation from the ERC-8004 registries.
            </p>
          </div>
        </div>
        <div className={styles.pageActions}>
          <Link to={`/review/${agentId.toString(10)}`}>
            <Button variant="primary" size="md" icon={<ReviewsIcon size={14} />} disabled={isOwner}>
              Submit review
            </Button>
          </Link>
        </div>
      </div>

      {agent.loading ? (
        <StatGrid>
          {/* Four, matching the four real cards, so the grid does not reflow
              when the data lands. */}
          {[0, 1, 2, 3].map((index) => (
            <Card key={index} padded>
              <Skeleton height={48} />
            </Card>
          ))}
        </StatGrid>
      ) : agent.error !== null ? (
        <Card>
          <EmptyState
            title="Couldn't load this agent"
            body="The RPC endpoint didn't respond."
            action={
              <Button variant="secondary" size="sm" onClick={agent.reload}>
                Try again
              </Button>
            }
          />
        </Card>
      ) : agent.data === null ? (
        <Card>
          <EmptyState
            title="Agent not found"
            body={`No agent with ID ${agentId.toString(10)} exists in the Identity Registry on this network.`}
            action={
              <Link to="/agents">
                <Button variant="secondary" size="sm">
                  Browse agents
                </Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          {isOwner && (
            <Notice tone="warning">
              You own this agent. The gateway rejects reviews from an owner or operator, so Submit
              review is disabled.
            </Notice>
          )}

          <StatGrid>
            <Stat
              label="Receipts Reputation"
              loading={reputation.loading}
              value={
                reputation.error !== null || reputation.data == null
                  ? null
                  : reputation.data.score === null
                    ? null
                    : String(reputation.data.score)
              }
              hint={
                reputation.error !== null
                  ? 'Score unavailable'
                  : reputation.data?.status === 'published'
                    ? `Weighted median of ${reputation.data.distinct_humans} verified humans`
                    : reputation.data == null
                      ? 'Loading'
                      : `Needs ${reputation.data.threshold} verified humans; ${reputation.data.distinct_humans} so far`
              }
              status={
                reputation.data?.status === 'published' ? (
                  <Badge tone="success" dot>
                    Published
                  </Badge>
                ) : undefined
              }
            />
            <Stat
              /* Deliberately not called a "Receipts score". This is the
                 registry's own unweighted mean, restricted to entries this
                 gateway authored. The weighted median that Receipts is meant
                 to publish is not implemented, and labelling a mean as that
                 score would claim manipulation-resistance the number does not
                 have — the AttackLab test exists precisely to show a mean
                 moving from 50 to 77 on six fake reviewers. */
              label="Registry mean"
              value={
                agent.data.receiptsSummary === null || agent.data.receiptsSummary.count === 0
                  ? null
                  : formatFeedbackValue(
                      agent.data.receiptsSummary.value,
                      agent.data.receiptsSummary.valueDecimals,
                    )
              }
              hint={
                agent.data.receiptsSummary === null || agent.data.receiptsSummary.count === 0
                  ? 'No Receipts reviews yet'
                  : `ERC-8004 mean of ${agent.data.receiptsSummary.count} Receipts review(s)`
              }
            />
            <Stat
              label="All ERC-8004 feedback"
              value={agent.data.summary === null ? null : String(agent.data.summary.count)}
              hint="Every client, Receipts included"
            />
            <Stat
              label="Verified reviews"
              loading={reputation.loading}
              value={
                reputation.data == null
                  ? null
                  : String(reputation.data.human_verified + reputation.data.receipt_verified)
              }
              hint={
                reputation.error !== null
                  ? 'Unavailable'
                  : reputation.data == null
                    ? 'Loading'
                    : `${reputation.data.human_verified} human-verified, ${reputation.data.receipt_verified} human-verified · paid`
              }
            />
          </StatGrid>

          <div className={styles.split}>
            <div className={styles.splitCol}>
              <Card>
                <CardHeader
                  title="Review history"
                  description="From this gateway's ReviewSubmitted events"
                />
                {reviews.loading ? (
                  <div
                    style={{ padding: 'var(--space-5)', display: 'grid', gap: 'var(--space-3)' }}
                  >
                    {[0, 1].map((row) => (
                      <Skeleton key={row} height={44} />
                    ))}
                  </div>
                ) : reviews.error !== null ? (
                  <EmptyState
                    compact
                    title="Couldn't load reviews"
                    body="Scanning for review events failed."
                    action={
                      <Button variant="secondary" size="sm" onClick={reviews.reload}>
                        Try again
                      </Button>
                    }
                  />
                ) : reviews.data === null || reviews.data.length === 0 ? (
                  <EmptyState
                    compact
                    icon={<ReviewsIcon size={18} />}
                    title="No reviews yet"
                    body="No one has reviewed this agent through Receipts yet."
                    action={
                      <Link to={`/review/${agentId.toString(10)}`}>
                        <Button variant="primary" size="sm" disabled={isOwner}>
                          Submit a review
                        </Button>
                      </Link>
                    }
                  />
                ) : (
                  <div>
                    {reviews.data.map((review) => (
                      <ReviewRow key={review.transactionHash} review={review} showAgent={false} />
                    ))}
                  </div>
                )}
              </Card>
            </div>

            <div className={styles.splitCol}>
              {reputation.data != null && <ReputationTiers reputation={reputation.data} />}
              <ArkivRecord agentId={agentId.toString(10)} reputation={reputation.data ?? null} />
              <Card>
                <CardHeader title="Identity" />
                <DescriptionList>
                  <DescriptionRow term="Agent ID">
                    <span className="mono">{agentId.toString(10)}</span>
                  </DescriptionRow>
                  <DescriptionRow term="Owner">
                    {agent.data.owner === null ? (
                      '—'
                    ) : (
                      <ExternalLink href={addressUrl(agent.data.owner)}>
                        {shortAddress(agent.data.owner)}
                      </ExternalLink>
                    )}
                  </DescriptionRow>
                  <DescriptionRow term="Payment wallet">
                    {agent.data.agentWallet === null || agent.data.agentWallet === ZERO ? (
                      <Badge tone="neutral">Not set</Badge>
                    ) : (
                      <ExternalLink href={addressUrl(agent.data.agentWallet)}>
                        {shortAddress(agent.data.agentWallet)}
                      </ExternalLink>
                    )}
                  </DescriptionRow>
                  <DescriptionRow term="Metadata">
                    {agent.data.tokenURI === null || agent.data.tokenURI === '' ? (
                      <span style={{ color: 'var(--text-muted)' }}>None</span>
                    ) : (
                      <Copyable
                        value={agent.data.tokenURI}
                        display={
                          agent.data.tokenURI.length > 22
                            ? `${agent.data.tokenURI.slice(0, 20)}…`
                            : agent.data.tokenURI
                        }
                      />
                    )}
                  </DescriptionRow>
                </DescriptionList>
              </Card>

              <Card>
                <CardHeader title="Data sources" />
                <DescriptionList>
                  <DescriptionRow term="Identity registry">
                    <ExternalLink href={addressUrl(config.identityRegistry)}>
                      {shortAddress(config.identityRegistry)}
                    </ExternalLink>
                  </DescriptionRow>
                  <DescriptionRow term="Reputation registry">
                    <ExternalLink href={addressUrl(config.reputationRegistry)}>
                      {shortAddress(config.reputationRegistry)}
                    </ExternalLink>
                  </DescriptionRow>
                  <DescriptionRow term="Review text">
                    <span style={{ color: 'var(--text-muted)' }}>Record Server</span>
                  </DescriptionRow>
                </DescriptionList>
              </Card>

              <Card>
                <CardHeader
                  title="How the score works"
                  action={
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={reputation.reload}
                      loading={reputation.loading}
                    >
                      Refresh
                    </Button>
                  }
                />
                <DescriptionList>
                  <DescriptionRow term="Method">lower weighted median</DescriptionRow>
                  <DescriptionRow term="Human-verified">weight 1</DescriptionRow>
                  <DescriptionRow term="Human-verified · Paid">
                    1 + min(USDC/10, 1), max 2
                  </DescriptionRow>
                  <DescriptionRow term="Threshold">
                    {reputation.data?.threshold ?? 5} verified humans
                  </DescriptionRow>
                  {reputation.data != null && (
                    <DescriptionRow term="Snapshot block">
                      <span className="mono">{reputation.data.snapshot_block}</span>
                    </DescriptionRow>
                  )}
                  {reputation.data != null && (
                    <DescriptionRow term="Evidence">
                      <Copyable
                        value={reputation.data.evidence_hash}
                        display={shortHash(reputation.data.evidence_hash)}
                      />
                    </DescriptionRow>
                  )}
                </DescriptionList>
                {reputation.data != null && (
                  <div style={{ padding: 'var(--space-4) var(--space-5)' }}>
                    <EvidenceViewer reputation={reputation.data} />
                  </div>
                )}
              </Card>

              {/* A failed score read is a chain or server problem, never an
                  absence of reviews, and must not be shown as one. */}
              {reputation.error !== null && (
                <Notice tone="danger">
                  The reputation service did not answer, so no score is shown. This is not the same
                  as an agent having no reviews.{' '}
                  <button
                    type="button"
                    onClick={reputation.reload}
                    style={{
                      color: 'var(--text-primary)',
                      textDecoration: 'underline',
                      font: 'inherit',
                    }}
                  >
                    Try again
                  </button>
                </Notice>
              )}

              <Notice tone="info">
                A median, not an average. An adversary holding under half the review weight cannot
                move the score outside the range honest reviewers gave; an average has no such
                bound. The <strong>Registry mean</strong> above is ERC-8004&rsquo;s own unweighted
                average, shown for comparison, and is not the Receipts score.
              </Notice>
            </div>
          </div>
        </>
      )}
    </>
  );
}

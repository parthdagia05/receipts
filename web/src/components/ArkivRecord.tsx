import { useAsync } from '../hooks/useAsync';
import {
  arkivAddressUrl,
  arkivPublisher,
  compareWithChain,
  curlFor,
  entityUrl,
  isExpired,
  loadArkivRecord,
  snapshotStanding,
  timeLeft,
  unpublishedCount,
} from '../lib/arkiv';
import type {
  ArkivRecord as Record,
  ArkivReview,
  ChainReview,
  WorldIdEnvironment,
} from '../lib/arkiv';
import type { ReputationResponse } from '../lib/api';
import { config, txUrl } from '../lib/config';
import { shortAddress, shortHash } from '../lib/format';
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
} from './ui';

const TYPE_LABEL: Readonly<{ [type: number]: string }> = {
  0: 'Human-verified',
  1: 'Human-verified · Paid',
  2: 'Wallet-verified',
};

/**
 * Receipts' public record for one agent, read from Arkiv in the browser.
 *
 * Deliberately independent of the Record Server: if our API is down, this
 * card still answers, because it asks the Arkiv node directly. It shows the
 * newest reputation snapshot the publisher wrote, the reviews it mirrored,
 * how long each has left before Arkiv drops it, and the exact query that
 * produced them so anyone can rerun it.
 *
 * When the API's own snapshot is for the same Sepolia block, the two
 * evidence hashes are compared; equal hashes mean the public copy says
 * exactly what the server computed. Each review is also checked against the
 * Sepolia review list the page already loaded, so a mirrored review that
 * disagrees with the chain shows up as such.
 */
export function ArkivRecord({
  agentId,
  reputation,
  chainReviews,
}: {
  agentId: string;
  reputation: ReputationResponse | null;
  /** The page's Sepolia reviews, or null while they load or if they failed. */
  chainReviews: readonly ChainReview[] | null;
}) {
  const publisher = arkivPublisher;
  const record = useAsync(
    () => (publisher === null ? Promise.resolve(null) : loadArkivRecord(agentId, publisher)),
    [agentId, publisher],
  );

  return (
    <Card tourId="arkiv-record">
      <CardHeader
        title="Public record on Arkiv"
        description="Read straight from the Arkiv testnet, not from our server"
        action={
          publisher !== null && (
            <Button variant="ghost" size="sm" onClick={record.reload} loading={record.loading}>
              Refresh
            </Button>
          )
        }
      />
      {publisher === null ? (
        <EmptyState
          compact
          title="Arkiv not configured"
          body="This build has no Arkiv publisher address, so it has no records it can trust."
        />
      ) : record.loading ? (
        <div style={{ padding: 'var(--space-5)', display: 'grid', gap: 'var(--space-3)' }}>
          <Skeleton height={20} />
          <Skeleton height={44} />
        </div>
      ) : record.error !== null || record.data === null ? (
        <EmptyState
          compact
          title="Couldn't reach Arkiv"
          body="The Arkiv node did not answer. This says nothing about the agent's reviews."
          action={
            <Button variant="secondary" size="sm" onClick={record.reload}>
              Try again
            </Button>
          }
        />
      ) : (
        <Body
          record={record.data}
          reputation={reputation}
          chainReviews={chainReviews}
          publisher={publisher}
        />
      )}
    </Card>
  );
}

function Body({
  record,
  reputation,
  chainReviews,
  publisher,
}: {
  record: Record;
  reputation: ReputationResponse | null;
  chainReviews: readonly ChainReview[] | null;
  publisher: `0x${string}`;
}) {
  const { snapshot } = record;
  const sameBlock =
    snapshot !== null &&
    reputation !== null &&
    reputation.snapshot_block === snapshot.snapshotBlock.toString(10);
  const pending = chainReviews === null ? 0 : unpublishedCount(record.reviews, chainReviews);

  const header = (
    <>
      <DescriptionRow term="Network">
        <Badge tone="success" dot>
          Connected
        </Badge>{' '}
        <span style={{ color: 'var(--text-muted)' }}>
          Rabdi testnet · Arkiv block {record.arkivBlock.toString(10)}
        </span>
      </DescriptionRow>
      <DescriptionRow term="Publisher">
        <ExternalLink href={arkivAddressUrl(publisher)}>{shortAddress(publisher)}</ExternalLink>
      </DescriptionRow>
    </>
  );

  if (snapshot === null && record.reviews.length === 0) {
    return (
      <>
        <DescriptionList>{header}</DescriptionList>
        <EmptyState
          compact
          title="No records published"
          body={
            pending > 0
              ? `Arkiv answered, but holds nothing for this agent yet. ${pending} Sepolia review${pending === 1 ? ' is' : 's are'} waiting to be published.`
              : 'Arkiv answered, but holds nothing for this agent yet.'
          }
        />
      </>
    );
  }

  const stagingReviews = record.reviews.filter((r) => r.worldIdEnvironment === 'staging').length;
  const standing = snapshot === null ? null : snapshotStanding(snapshot);

  return (
    <>
      {(stagingReviews > 0 || standing === 'test') && (
        <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
          <Notice tone="warning">
            Test data.{' '}
            {stagingReviews > 0
              ? stagingReviews === 1
                ? `${stagingReviews} of these reviews was`
                : `${stagingReviews} of these reviews were`
              : 'Reviews behind this score were'}{' '}
            verified with staging World ID, which only accepts the World ID Simulator. This shows
            the pipeline working, not real people.
          </Notice>
        </div>
      )}
      <DescriptionList>
        {header}
        {snapshot === null ? (
          <DescriptionRow term="Snapshot">
            <span style={{ color: 'var(--text-muted)' }}>None published yet</span>
          </DescriptionRow>
        ) : (
          <>
            <DescriptionRow term="Score">
              {snapshot.score === null ? (
                <span>
                  No score{' '}
                  <span style={{ color: 'var(--text-muted)' }}>
                    ({snapshot.status.replace(/_/g, ' ')})
                  </span>
                </span>
              ) : (
                <strong>{snapshot.score}</strong>
              )}
            </DescriptionRow>
            <DescriptionRow term="Verified humans">
              {snapshot.distinctHumans} of {snapshot.threshold} needed
            </DescriptionRow>
            <DescriptionRow term="World ID">
              {standing === 'production' ? (
                <Badge tone="success" dot>
                  All production
                </Badge>
              ) : standing === 'test' ? (
                <Badge tone="warning" dot>
                  Includes Simulator tests
                </Badge>
              ) : (
                <Badge tone="warning" dot>
                  Includes unknown provenance
                </Badge>
              )}{' '}
              <span style={{ color: 'var(--text-muted)' }}>
                {snapshot.productionVerifiedCount} production · {snapshot.stagingVerifiedCount}{' '}
                staging · {snapshot.unknownProvenanceCount} unknown
              </span>
            </DescriptionRow>
            <DescriptionRow term="Sepolia block">
              <span className="mono">{snapshot.snapshotBlock.toString(10)}</span>
            </DescriptionRow>
            <DescriptionRow term="Evidence hash">
              <span style={{ display: 'inline-flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                <Copyable
                  value={snapshot.manifestHash}
                  display={shortHash(snapshot.manifestHash)}
                />
                {sameBlock &&
                  (reputation.evidence_hash.toLowerCase() ===
                  snapshot.manifestHash.toLowerCase() ? (
                    <Badge tone="success" dot>
                      Matches API
                    </Badge>
                  ) : (
                    <Badge tone="danger" dot>
                      Differs from API
                    </Badge>
                  ))}
              </span>
            </DescriptionRow>
            {/* The API scores at the current head on every request, so its
                block almost never equals a published snapshot's. Then the
                hashes cannot be compared (the manifest names its block), but
                the standing they describe can. */}
            {!sameBlock && reputation !== null && (
              <DescriptionRow term="Versus API now">
                {reputation.status === snapshot.status &&
                reputation.score === snapshot.score &&
                reputation.distinct_humans === snapshot.distinctHumans ? (
                  <Badge tone="success" dot>
                    Same standing
                  </Badge>
                ) : (
                  <Badge tone="warning" dot>
                    API has moved on
                  </Badge>
                )}{' '}
                <span style={{ color: 'var(--text-muted)' }}>
                  API is at block {reputation.snapshot_block}
                </span>
              </DescriptionRow>
            )}
            <DescriptionRow term="Snapshot entity">
              <ExternalLink href={entityUrl(snapshot.entityKey)}>
                {shortHash(snapshot.entityKey)}
              </ExternalLink>{' '}
              <Expiry expiresAt={snapshot.expiresAt} atBlock={record.arkivBlock} />
            </DescriptionRow>
          </>
        )}
        <DescriptionRow term="Reviews on Arkiv">
          {record.reviews.length}
          {pending > 0 && (
            <span style={{ color: 'var(--text-muted)' }}>
              {' '}
              · {pending} more on Sepolia not yet published
            </span>
          )}
        </DescriptionRow>
      </DescriptionList>

      {record.reviews.length > 0 && (
        <div
          style={{
            padding: '0 var(--space-5) var(--space-4)',
            display: 'grid',
            gap: 'var(--space-3)',
          }}
        >
          {record.reviews.map((review) => (
            <ReviewEntity
              key={review.entityKey}
              review={review}
              atBlock={record.arkivBlock}
              chainReviews={chainReviews}
            />
          ))}
        </div>
      )}

      <div style={{ padding: '0 var(--space-5) var(--space-4)' }}>
        <Notice tone="info">
          Anyone can fetch these records without Receipts. Reviews query:{' '}
          <Copyable value={curlFor(record.reviewQuery)} display="copy curl" />
          {' · '}snapshot query:{' '}
          <Copyable value={curlFor(record.snapshotQuery)} display="copy curl" />
        </Notice>
      </div>
    </>
  );
}

function Expiry({ expiresAt, atBlock }: { expiresAt: bigint; atBlock: bigint }) {
  return isExpired(expiresAt, atBlock) ? (
    <Badge tone="danger" dot>
      Expired
    </Badge>
  ) : (
    <span style={{ color: 'var(--text-muted)' }}>expires in {timeLeft(expiresAt, atBlock)}</span>
  );
}

function ReviewEntity({
  review,
  atBlock,
  chainReviews,
}: {
  review: ArkivReview;
  atBlock: bigint;
  chainReviews: readonly ChainReview[] | null;
}) {
  const comparison = chainReviews === null ? null : compareWithChain(review, chainReviews);
  return (
    <div
      style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        padding: 'var(--space-3)',
        display: 'grid',
        gap: 'var(--space-2)',
      }}
    >
      <div
        style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}
      >
        <Badge tone={review.reviewType === 2 ? 'neutral' : 'accent'}>
          {TYPE_LABEL[review.reviewType] ?? review.tag}
        </Badge>
        <strong>{review.value}</strong>
        <span style={{ color: 'var(--text-muted)' }}>by {shortAddress(review.reviewer)}</span>
        <ProvenanceBadge environment={review.worldIdEnvironment} />
        {comparison === 'matches' && (
          <Badge tone="success" dot>
            Matches Sepolia
          </Badge>
        )}
        {comparison === 'differs' && (
          <Badge tone="danger" dot>
            Differs from Sepolia
          </Badge>
        )}
      </div>
      {review.text !== null && <p style={{ margin: 0 }}>{review.text}</p>}
      <div>
        {review.contentStatus === 'verified' ? (
          <Badge tone="success" dot>
            Text matches on-chain hash
          </Badge>
        ) : review.contentStatus === 'mismatch' ? (
          <Badge tone="danger" dot>
            Text does not match hash
          </Badge>
        ) : (
          <Badge tone="warning" dot>
            No text stored
          </Badge>
        )}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          columnGap: 'var(--space-3)',
          rowGap: 'var(--space-1)',
          fontSize: 13,
        }}
      >
        <span style={{ color: 'var(--text-muted)' }}>Feedback hash</span>
        <Copyable value={review.feedbackHash} display={shortHash(review.feedbackHash)} />
        <span style={{ color: 'var(--text-muted)' }}>Feedback index</span>
        <span className="mono">{review.feedbackIndex.toString(10)}</span>
        <span style={{ color: 'var(--text-muted)' }}>Sepolia block</span>
        <span className="mono">{review.blockNumber.toString(10)}</span>
        <span style={{ color: 'var(--text-muted)' }}>Gateway</span>
        <span className="mono">{shortAddress(review.gateway)}</span>
        <span style={{ color: 'var(--text-muted)' }}>World ID RP</span>
        <span className="mono">{review.worldIdRpId ?? 'not recorded'}</span>
        <span style={{ color: 'var(--text-muted)' }}>Entity</span>
        <Copyable value={review.entityKey} display={shortHash(review.entityKey)} />
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', fontSize: 13 }}>
        <ExternalLink href={entityUrl(review.entityKey)}>Arkiv entity</ExternalLink>
        <ExternalLink href={txUrl(review.txHash)}>Sepolia tx</ExternalLink>
        <ExternalLink href={`${config.apiBaseUrl}/reviews/${review.feedbackHash}`}>
          Public text
        </ExternalLink>
        <Expiry expiresAt={review.expiresAt} atBlock={atBlock} />
      </div>
    </div>
  );
}

const PROVENANCE: Readonly<{
  [E in WorldIdEnvironment]: { tone: 'success' | 'warning' | 'neutral'; label: string };
}> = {
  production: { tone: 'success', label: 'Production World ID' },
  staging: { tone: 'warning', label: 'Staging World ID · Simulator test' },
  none: { tone: 'neutral', label: 'No World ID' },
  unknown: { tone: 'warning', label: 'World ID provenance unknown' },
};

/** The publisher's record of how a review was verified. Not on Sepolia. */
function ProvenanceBadge({ environment }: { environment: WorldIdEnvironment }) {
  const { tone, label } = PROVENANCE[environment];
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

import { useAsync } from '../hooks/useAsync';
import {
  arkivAddressUrl,
  arkivPublisher,
  curlFor,
  entityUrl,
  loadArkivRecord,
  timeLeft,
} from '../lib/arkiv';
import type { ArkivRecord as Record } from '../lib/arkiv';
import type { ReputationResponse } from '../lib/api';
import { txUrl } from '../lib/config';
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
 * exactly what the server computed.
 */
export function ArkivRecord({
  agentId,
  reputation,
}: {
  agentId: string;
  reputation: ReputationResponse | null;
}) {
  const publisher = arkivPublisher;
  const record = useAsync(
    () => (publisher === null ? Promise.resolve(null) : loadArkivRecord(agentId, publisher)),
    [agentId, publisher],
  );

  return (
    <Card>
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
        <Body record={record.data} reputation={reputation} publisher={publisher} />
      )}
    </Card>
  );
}

function Body({
  record,
  reputation,
  publisher,
}: {
  record: Record;
  reputation: ReputationResponse | null;
  publisher: `0x${string}`;
}) {
  const { snapshot } = record;
  const sameBlock =
    snapshot !== null &&
    reputation !== null &&
    reputation.snapshot_block === snapshot.snapshotBlock.toString(10);

  return (
    <>
      <DescriptionList>
        <DescriptionRow term="Publisher">
          <ExternalLink href={arkivAddressUrl(publisher)}>{shortAddress(publisher)}</ExternalLink>
        </DescriptionRow>
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
            <DescriptionRow term="Entity">
              <ExternalLink href={entityUrl(snapshot.entityKey)}>
                {shortHash(snapshot.entityKey)}
              </ExternalLink>{' '}
              <span style={{ color: 'var(--text-muted)' }}>
                expires in {timeLeft(snapshot.expiresAt, record.arkivBlock)}
              </span>
            </DescriptionRow>
          </>
        )}
        <DescriptionRow term="Reviews on Arkiv">{record.reviews.length}</DescriptionRow>
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
            <div
              key={review.entityKey}
              style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 8,
                padding: 'var(--space-3)',
                display: 'grid',
                gap: 'var(--space-2)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <Badge tone={review.reviewType === 2 ? 'neutral' : 'accent'}>
                  {TYPE_LABEL[review.reviewType] ?? review.tag}
                </Badge>
                <strong>{review.value}</strong>
                <span style={{ color: 'var(--text-muted)' }}>
                  by {shortAddress(review.reviewer)}
                </span>
              </div>
              {review.text !== null && (
                <p style={{ margin: 0 }}>
                  {review.text}{' '}
                  {review.contentVerified ? (
                    <Badge tone="success" dot>
                      Text matches on-chain hash
                    </Badge>
                  ) : (
                    <Badge tone="danger" dot>
                      Text does not match hash
                    </Badge>
                  )}
                </p>
              )}
              <div
                style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', fontSize: 13 }}
              >
                <ExternalLink href={entityUrl(review.entityKey)}>Arkiv entity</ExternalLink>
                <ExternalLink href={txUrl(review.txHash)}>Sepolia tx</ExternalLink>
                <span style={{ color: 'var(--text-muted)' }}>
                  expires in {timeLeft(review.expiresAt, record.arkivBlock)}
                </span>
              </div>
            </div>
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

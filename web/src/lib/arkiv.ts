import { createPublicClient } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { desc, eq } from '@arkiv-network/sdk/query';
import { addr, bytes, defineSchema, i32, str, u64 } from '@arkiv-network/sdk/schema';
import { getAddress, hexToBytes, http, isAddress, keccak256 } from 'viem';
import type { Address, Hex } from 'viem';

/**
 * Reads of Receipts' public record on Arkiv, straight from the Arkiv node.
 *
 * Nothing here goes through the Record Server. That is the point of the
 * panel: the same records an independent app would read, fetched the way it
 * would fetch them, so the page keeps working when our API does not.
 *
 * The schemas mirror `server/src/arkiv/schemas.ts`, which documents each
 * column. They are a published interface; keep the two identical.
 *
 * Every query is filtered on `$creator` = the configured publisher. Arkiv
 * lets anyone write under any schema tag, so the tag alone would also match
 * entities that merely claim to be Receipts records.
 */

export const ReviewSchema = defineSchema('receipts.review/v1', {
  agentId: str().indexed(),
  chainId: u64().indexed(),
  gateway: addr().indexed(),
  reviewer: addr().indexed(),
  reviewType: i32().indexed(),
  tag: str().indexed(),
  value: i32().indexed(),
  valueDecimals: i32(),
  feedbackIndex: u64().indexed(),
  feedbackHash: str().indexed(),
  receiptId: str().optional(),
  txHash: str().indexed(),
  logIndex: i32(),
  blockNumber: u64().indexed(),
  content: bytes().optional(),
  contentType: str().default('text/plain; charset=utf-8'),
});

export const ReputationSchema = defineSchema('receipts.reputation/v1', {
  agentId: str().indexed(),
  chainId: u64().indexed(),
  spec: str().indexed(),
  status: str().indexed(),
  score: i32().indexed().optional(),
  distinctHumans: i32().indexed(),
  threshold: i32(),
  humanVerifiedCount: i32(),
  receiptVerifiedCount: i32(),
  receiptScore: i32().optional(),
  receiptStatus: str(),
  walletCount: i32(),
  totalWeight: str(),
  unattributableCount: i32(),
  snapshotBlock: u64().indexed(),
  manifestHash: str().indexed(),
  reviewGateway: addr(),
});

export const ARKIV_RPC_URL = 'https://rpc.rabdi.db-chain.testnet.arkiv.network';
export const ARKIV_EXPLORER_URL = 'https://rabdi.explorer.arkiv.network';
/** Seconds per Rabdi block. */
const BLOCK_SECONDS = 2;

/**
 * The publisher whose records the panel trusts, from
 * `VITE_ARKIV_PUBLISHER_ADDRESS`. Unset, the panel says Arkiv is not
 * configured rather than showing whatever anyone wrote under the tag.
 */
export const arkivPublisher: Address | null = (() => {
  const raw = (import.meta.env['VITE_ARKIV_PUBLISHER_ADDRESS'] as string | undefined)?.trim();
  return raw !== undefined && raw !== '' && isAddress(raw, { strict: false })
    ? getAddress(raw)
    : null;
})();

// Reads need no key. An origin-locked key from `VITE_ARKIV_ACCESS_KEY` raises
// the rate limit; it is public by nature, as the SDK documents.
const client = createPublicClient({
  chain: rabdi({
    accessKey: (import.meta.env['VITE_ARKIV_ACCESS_KEY'] as string | undefined)?.trim() ?? '',
  }),
  transport: http(),
});

export interface ArkivReview {
  readonly entityKey: Hex;
  readonly expiresAt: bigint;
  readonly reviewType: number;
  readonly tag: string;
  readonly value: number;
  readonly reviewer: Address;
  readonly txHash: Hex;
  readonly feedbackHash: Hex;
  /** The review text, when the entity carries it. */
  readonly text: string | null;
  /** True only when the carried text hashes to the on-chain feedbackHash. */
  readonly contentVerified: boolean;
}

export interface ArkivSnapshot {
  readonly entityKey: Hex;
  readonly expiresAt: bigint;
  readonly status: string;
  readonly score: number | null;
  readonly distinctHumans: number;
  readonly threshold: number;
  readonly humanVerifiedCount: number;
  readonly receiptVerifiedCount: number;
  readonly snapshotBlock: bigint;
  readonly manifestHash: Hex;
}

export interface ArkivRecord {
  readonly snapshot: ArkivSnapshot | null;
  readonly reviews: readonly ArkivReview[];
  /** The Arkiv block the reads were answered at. */
  readonly arkivBlock: bigint;
  /** The query text the panel ran for reviews, for anyone to rerun. */
  readonly reviewQuery: string;
  readonly snapshotQuery: string;
}

function reviewQuery(agentId: string, publisher: Address) {
  return client
    .select({
      $key: true,
      $expiresAt: true,
      reviewType: true,
      tag: true,
      value: true,
      reviewer: true,
      txHash: true,
      feedbackHash: true,
      content: true,
    })
    .from(ReviewSchema)
    .where(eq('agentId', agentId))
    .createdBy(publisher)
    .orderBy(desc('blockNumber'))
    .limit(50);
}

function snapshotQuery(agentId: string, publisher: Address) {
  return client
    .select({
      $key: true,
      $expiresAt: true,
      status: true,
      score: true,
      distinctHumans: true,
      threshold: true,
      humanVerifiedCount: true,
      receiptVerifiedCount: true,
      snapshotBlock: true,
      manifestHash: true,
    })
    .from(ReputationSchema)
    .where(eq('agentId', agentId))
    .createdBy(publisher)
    .orderBy(desc('snapshotBlock'))
    .limit(1);
}

export async function loadArkivRecord(agentId: string, publisher: Address): Promise<ArkivRecord> {
  const reviewsQ = reviewQuery(agentId, publisher);
  const snapshotQ = snapshotQuery(agentId, publisher);
  const [reviewPage, snapshotPage] = await Promise.all([reviewsQ.fetch(), snapshotQ.fetch()]);

  const reviews = reviewPage.entities.map((row): ArkivReview => {
    const feedbackHash = row.feedbackHash.value as Hex;
    const content = row.content === undefined ? null : hexToBytes(row.content.value);
    const contentVerified = content !== null && keccak256(content) === feedbackHash.toLowerCase();
    return {
      entityKey: row.$key,
      expiresAt: row.$expiresAt,
      reviewType: row.reviewType.value,
      tag: row.tag.value,
      value: row.value.value,
      reviewer: getAddress(row.reviewer.value),
      txHash: row.txHash.value as Hex,
      feedbackHash,
      text: content === null ? null : new TextDecoder().decode(content),
      contentVerified,
    };
  });

  const s = snapshotPage.entities[0];
  const snapshot: ArkivSnapshot | null =
    s === undefined
      ? null
      : {
          entityKey: s.$key,
          expiresAt: s.$expiresAt,
          status: s.status.value,
          score: s.score?.value ?? null,
          distinctHumans: s.distinctHumans.value,
          threshold: s.threshold.value,
          humanVerifiedCount: s.humanVerifiedCount.value,
          receiptVerifiedCount: s.receiptVerifiedCount.value,
          snapshotBlock: s.snapshotBlock.value,
          manifestHash: s.manifestHash.value as Hex,
        };

  return {
    snapshot,
    reviews,
    arkivBlock:
      reviewPage.blockNumber > snapshotPage.blockNumber
        ? reviewPage.blockNumber
        : snapshotPage.blockNumber,
    reviewQuery: reviewsQ.toString(),
    snapshotQuery: snapshotQ.toString(),
  };
}

/** A curl command that runs `query` against the public Arkiv RPC, no key needed. */
export function curlFor(query: string): string {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'arkiv_query',
    params: [
      query,
      { select: { key: true, owner: true, expiresAt: true, attributes: true }, limit: '0x32' },
    ],
  });
  return `curl -s ${ARKIV_RPC_URL} -H 'content-type: application/json' -d '${body.replace(/'/g, `'\\''`)}'`;
}

export const entityUrl = (key: Hex): string => `${ARKIV_EXPLORER_URL}/entity/${key}`;
export const arkivAddressUrl = (address: Address): string =>
  `${ARKIV_EXPLORER_URL}/address/${address}`;

/** Roughly how long until `expiresAt`, from the block the read was answered at. */
export function timeLeft(expiresAt: bigint, atBlock: bigint): string {
  if (expiresAt <= atBlock) return 'expired';
  const seconds = Number(expiresAt - atBlock) * BLOCK_SECONDS;
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.max(1, Math.floor(seconds / 3_600));
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

import { addr, u64 } from '@arkiv-network/sdk/schema';
import type { CreateEntityValues } from '@arkiv-network/sdk/schema';
import { bytesToHex, keccak256 } from 'viem';
import type { Address, Hex } from 'viem';
import type { ReputationResult } from '../reputation/engine.js';
import { TAG2_FREE, TAG2_PAID, TAG2_WALLET } from '../reputation/spec.js';
import type { ReputationSchema, ReviewSchema } from './schemas.js';

/**
 * A review the indexer has seen confirmed on Sepolia, reduced to what may be
 * published.
 *
 * There is deliberately no `nullifier` here. `ReviewSubmitted` carries one,
 * and the indexer discards it while decoding, so no code path past the
 * indexer can put it into an entity by mistake.
 */
export interface ConfirmedReview {
  readonly agentId: bigint;
  readonly gateway: Address;
  readonly reviewer: Address;
  readonly reviewType: number;
  readonly tag: string;
  readonly value: bigint;
  readonly valueDecimals: number;
  readonly feedbackIndex: bigint;
  readonly feedbackHash: Hex;
  /** Zero for an unpaid review. */
  readonly receiptId: Hex;
  readonly txHash: Hex;
  readonly logIndex: number;
  readonly blockNumber: bigint;
}

const ZERO_BYTES32: Hex = `0x${'00'.repeat(32)}`;

/** The tag the gateway writes for each review type; anything else is refused. */
const TAG_FOR_TYPE: Record<number, string> = {
  0: TAG2_FREE,
  1: TAG2_PAID,
  2: TAG2_WALLET,
};

/** Raised when a value cannot be published as given. Never carries content. */
export class ArkivRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArkivRecordError';
  }
}

/**
 * Review content, kept only if it hashes to the review's `feedbackHash`.
 *
 * The content comes from our own server, but the entity claims it is the
 * text the reviewer signed. That claim is checked here rather than assumed:
 * bytes that do not hash to the on-chain value are dropped, and the entity is
 * published without content instead of with the wrong one.
 */
export function verifiedContent(
  review: Pick<ConfirmedReview, 'feedbackHash'>,
  content: Uint8Array | null,
): Uint8Array | null {
  if (content === null) return null;
  return keccak256(content).toLowerCase() === review.feedbackHash.toLowerCase() ? content : null;
}

/** The `receipts.review/v1` values for one confirmed review. */
export function reviewEntityValues(
  review: ConfirmedReview,
  chainId: number,
  content: Uint8Array | null,
): CreateEntityValues<typeof ReviewSchema> {
  if (TAG_FOR_TYPE[review.reviewType] !== review.tag) {
    throw new ArkivRecordError(`tx ${review.txHash}: tag does not match reviewType`);
  }
  // The gateway accepts 0..100 only; anything else did not come through it.
  if (review.value < 0n || review.value > 100n) {
    throw new ArkivRecordError(`tx ${review.txHash}: value out of range`);
  }
  const checked = verifiedContent(review, content);
  return {
    agentId: review.agentId.toString(10),
    chainId: u64(chainId),
    gateway: addr(review.gateway),
    reviewer: addr(review.reviewer),
    reviewType: review.reviewType,
    tag: review.tag,
    value: Number(review.value),
    valueDecimals: review.valueDecimals,
    feedbackIndex: u64(review.feedbackIndex),
    feedbackHash: review.feedbackHash.toLowerCase(),
    ...(review.receiptId.toLowerCase() === ZERO_BYTES32
      ? {}
      : { receiptId: review.receiptId.toLowerCase() }),
    txHash: review.txHash.toLowerCase(),
    logIndex: review.logIndex,
    blockNumber: u64(review.blockNumber),
    ...(checked === null ? {} : { content: checked }),
  };
}

/** Identifies one on-chain review across runs: one log in one transaction. */
export function reviewId(review: Pick<ConfirmedReview, 'txHash' | 'logIndex'>): string {
  return `${review.txHash.toLowerCase()}:${review.logIndex}`;
}

/** What a reputation snapshot is computed from, as the API computes it. */
export interface SnapshotInput {
  readonly agentId: bigint;
  readonly chainId: number;
  readonly spec: string;
  readonly snapshotBlock: bigint;
  readonly manifestHash: Hex;
  readonly reviewGateway: Address;
  readonly result: ReputationResult;
  readonly unattributableCount: number;
}

/**
 * The `receipts.reputation/v1` values for one snapshot.
 *
 * The evidence manifest itself is not published: it lists every eligible
 * review's World ID nullifier. Only its hash goes out, which is enough for a
 * consumer to check this snapshot against the API or a recomputation.
 */
export function reputationEntityValues(
  input: SnapshotInput,
): CreateEntityValues<typeof ReputationSchema> {
  const { result } = input;
  const receipt = result.tiers.receipt;
  return {
    agentId: input.agentId.toString(10),
    chainId: u64(input.chainId),
    spec: input.spec,
    status: result.status,
    ...(result.score === null ? {} : { score: Number(result.score) }),
    distinctHumans: result.distinctHumans,
    threshold: result.threshold,
    humanVerifiedCount: result.humanVerifiedCount,
    receiptVerifiedCount: result.receiptVerifiedCount,
    ...(receipt.score === null ? {} : { receiptScore: Number(receipt.score) }),
    receiptStatus: receipt.status,
    walletCount: result.tiers.wallet.count,
    totalWeight: result.totalWeight.toString(10),
    unattributableCount: input.unattributableCount,
    snapshotBlock: u64(input.snapshotBlock),
    manifestHash: input.manifestHash.toLowerCase(),
    reviewGateway: addr(input.reviewGateway),
  };
}

/**
 * The fields that decide whether a snapshot says anything new.
 *
 * `snapshotBlock` and `manifestHash` change on every run, because the
 * manifest names its block, so they cannot be compared. Two snapshots that
 * agree on everything here describe the same standing, and the older entity
 * is extended instead of a duplicate being written.
 */
export function snapshotFingerprint(values: {
  readonly status: string;
  readonly score?: number | undefined;
  readonly distinctHumans: number;
  readonly humanVerifiedCount: number;
  readonly receiptVerifiedCount: number;
  readonly receiptScore?: number | undefined;
  readonly walletCount: number;
  readonly totalWeight: string;
  readonly unattributableCount: number;
  readonly spec: string;
}): string {
  return [
    values.spec,
    values.status,
    values.score ?? '-',
    values.distinctHumans,
    values.humanVerifiedCount,
    values.receiptVerifiedCount,
    values.receiptScore ?? '-',
    values.walletCount,
    values.totalWeight,
    values.unattributableCount,
  ].join('|');
}

/** Human-readable rendering of entity values, for the dry-run report. */
export function describeValues(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value instanceof Uint8Array) {
      out[key] = {
        bytes: value.length,
        utf8: new TextDecoder().decode(value),
        hex: bytesToHex(value),
      };
    } else if (typeof value === 'object' && value !== null && 'type' in value && 'value' in value) {
      const tagged = value as { type: string; value: unknown };
      out[key] = `${tagged.type}(${String(tagged.value)})`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

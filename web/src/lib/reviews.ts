import type { Address, Hex } from 'viem';
import { reviewGatewayAbi } from './abi';
import { MAX_LOG_RANGE, publicClient } from './chain';
import { config } from './config';

/**
 * Receipts reviews, read from the gateway's own `ReviewSubmitted` events.
 *
 * The event is self-contained by design: agent, reviewer, nullifier, review
 * type, receipt id and evidence hash are all on it, so a review can be
 * reconstructed without joining against ERC-8004's `NewFeedback` or trusting
 * transaction ordering. That is why this file reads our gateway rather than
 * the Reputation Registry — the registry attributes feedback to the gateway
 * address, not to the human who wrote it.
 */

export const REVIEW_TYPE = { FREE: 0, PAID: 1, WALLET: 2 } as const;

/**
 * How a review was verified, as shown to a reader.
 *
 * Wallet verification proves only that a wallet signed. One person can control
 * many wallets, so it is a different kind of claim from World ID and must never
 * be rendered with the same words.
 */
export type VerificationType =
  'world_id_human' | 'world_id_human_paid' | 'wallet_only' | 'unverified';

/** The `tag2` the gateway writes for each review type. */
export const REVIEW_TAG2 = {
  human: 'human-verified',
  paid: 'receipt-verified',
  wallet: 'wallet-verified',
} as const;

export const VERIFICATION_LABEL: Readonly<Record<VerificationType, string>> = {
  world_id_human: 'Human-verified',
  world_id_human_paid: 'Human-verified · Paid',
  wallet_only: 'Wallet-verified',
  unverified: 'Unverified',
};

export const WALLET_TOOLTIP =
  'A wallet signed this review. This does not prove one person, since one person can control many wallets. Not counted in the reputation score.';

export const VERIFICATION_TOOLTIP: Readonly<Record<VerificationType, string>> = {
  world_id_human: 'A unique person proved they are human with World ID Proof of Human.',
  world_id_human_paid:
    'A unique person proved they are human with World ID Proof of Human and paid the agent with a settled USDC receipt.',
  wallet_only: WALLET_TOOLTIP,
  unverified: 'This review has an unknown or inconsistent verification type.',
};

/**
 * Map a review's on-chain type, and its `tag2` when known, to a verification.
 *
 * Fails closed: any combination that is not one of the three known pairs is
 * `unverified`. `tag2` is optional because `ReviewSubmitted` carries only the
 * type, and the gateway fixes the tag per type; when a tag *is* supplied it
 * must agree with the type, so a mismatch can never upgrade a review.
 */
export function verificationOf(
  reviewType: number,
  tag2?: string | null | undefined,
): VerificationType {
  const check = (expected: string, result: VerificationType): VerificationType =>
    tag2 === undefined || tag2 === null || tag2 === expected ? result : 'unverified';

  switch (reviewType) {
    case REVIEW_TYPE.FREE:
      return check(REVIEW_TAG2.human, 'world_id_human');
    case REVIEW_TYPE.PAID:
      return check(REVIEW_TAG2.paid, 'world_id_human_paid');
    case REVIEW_TYPE.WALLET:
      return check(REVIEW_TAG2.wallet, 'wallet_only');
    default:
      return 'unverified';
  }
}

export interface ReviewRecord {
  readonly agentId: bigint;
  readonly reviewer: Address;
  readonly nullifier: Hex;
  readonly reviewType: number;
  readonly receiptId: Hex;
  readonly feedbackHash: Hex;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  /** Filled in by `attachTimestamps`; absent until then. */
  readonly timestamp?: number;
}

/**
 * Scan backwards for `ReviewSubmitted` events.
 *
 * Public endpoints cap `eth_getLogs` at a fixed block span, so the range is
 * walked in windows from the head down to the gateway's deployment block, and
 * the walk stops as soon as `limit` events have been collected. Scanning
 * forwards would mean reading the whole history before knowing what is recent.
 */
export async function loadReviews(options?: {
  agentId?: bigint;
  reviewer?: Address;
  limit?: number;
}): Promise<ReviewRecord[]> {
  const limit = options?.limit ?? 25;
  const head = await publicClient.getBlockNumber();
  const floor = config.gatewayDeployBlock;

  const collected: ReviewRecord[] = [];
  let toBlock = head;

  while (toBlock >= floor && collected.length < limit) {
    const fromBlock = toBlock - MAX_LOG_RANGE + 1n > floor ? toBlock - MAX_LOG_RANGE + 1n : floor;

    const logs = await publicClient.getContractEvents({
      address: config.reviewGateway,
      abi: reviewGatewayAbi,
      eventName: 'ReviewSubmitted',
      fromBlock,
      toBlock,
      args: {
        ...(options?.agentId === undefined ? {} : { agentId: options.agentId }),
        ...(options?.reviewer === undefined ? {} : { reviewer: options.reviewer }),
      },
    });

    // Newest first within the window.
    for (const log of [...logs].reverse()) {
      const args = log.args;
      if (
        args.agentId === undefined ||
        args.reviewer === undefined ||
        args.nullifier === undefined ||
        args.reviewType === undefined ||
        args.receiptId === undefined ||
        args.feedbackHash === undefined
      ) {
        continue;
      }
      collected.push({
        agentId: args.agentId,
        reviewer: args.reviewer,
        nullifier: args.nullifier,
        reviewType: args.reviewType,
        receiptId: args.receiptId,
        feedbackHash: args.feedbackHash,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      });
      if (collected.length >= limit) break;
    }

    if (fromBlock === floor) break;
    toBlock = fromBlock - 1n;
  }

  return collected;
}

/**
 * Attach block timestamps to a page of reviews.
 *
 * Separate from the scan because it costs one `eth_getBlock` per distinct
 * block, and a list that renders without timestamps is better than one that
 * waits for them. Blocks that cannot be read simply leave `timestamp` unset,
 * and the UI omits the time rather than guessing one.
 */
export async function attachTimestamps(reviews: readonly ReviewRecord[]): Promise<ReviewRecord[]> {
  const distinct = [...new Set(reviews.map((review) => review.blockNumber))];

  const entries = await Promise.all(
    distinct.map(async (blockNumber) => {
      try {
        const block = await publicClient.getBlock({ blockNumber });
        return [blockNumber, Number(block.timestamp)] as const;
      } catch {
        return [blockNumber, undefined] as const;
      }
    }),
  );
  const byBlock = new Map(entries);

  return reviews.map((review) => {
    const timestamp = byBlock.get(review.blockNumber);
    return timestamp === undefined ? review : { ...review, timestamp };
  });
}

/** Total `ReviewSubmitted` events, split by review type. */
export interface ReviewTotals {
  readonly total: number;
  readonly free: number;
  readonly paid: number;
  readonly wallet: number;
}

export async function loadReviewTotals(): Promise<ReviewTotals> {
  // The complete history is what the metrics describe. The cap keeps a pathological day
  // from turning the dashboard into an unbounded scan.
  const all = await loadReviews({ limit: 1_000 });
  return {
    total: all.length,
    free: all.filter((review) => review.reviewType === REVIEW_TYPE.FREE).length,
    paid: all.filter((review) => review.reviewType === REVIEW_TYPE.PAID).length,
    wallet: all.filter((review) => review.reviewType === REVIEW_TYPE.WALLET).length,
  };
}

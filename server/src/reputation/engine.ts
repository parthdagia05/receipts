import {
  FREE_WEIGHT,
  MAX_RATING,
  MIN_DISTINCT_HUMANS,
  MIN_RATING,
  REQUIRED_VALUE_DECIMALS,
  REVIEW_TYPE_FREE,
  REVIEW_TYPE_PAID,
  REVIEW_TYPE_WALLET,
  WALLET_TIER_THRESHOLD,
  paidWeight,
  walletNullifier,
} from './spec.js';
import { isAddress } from 'viem';
import type { Address } from 'viem';

/**
 * The Receipts reputation calculation.
 *
 * Pure: it takes already-retrieved, already-attributed review records and
 * returns a score. It performs no I/O and knows nothing about chains, which
 * is what makes the property tests below meaningful — they exercise the real
 * function, not a reimplementation of it.
 *
 * Why a weighted median and not a mean: the AttackLab test in this repo shows
 * six fresh addresses moving an ERC-8004 mean from 50 to 77, because a mean
 * has a breakdown point of zero. A median's breakdown point is 1/2, so an
 * adversary holding strictly less than half the total weight cannot move the
 * score outside the range of honest values at all.
 */

/**
 * The canonical form of a nullifier for comparison.
 *
 * Lowercased hex. A nullifier is an opaque identity key, and two spellings of
 * the same bytes must not count as two humans.
 */
export function normalizeNullifier(nullifier: string): string {
  return nullifier.trim().toLowerCase();
}

/** One candidate review, as retrieval produces it. */
export interface ReviewInput {
  /** World ID nullifier. The identity key; on-chain unique per (human, agent). */
  readonly nullifier: string;
  /** Rating as written to ERC-8004. */
  readonly value: bigint;
  /** ERC-8004 decimal exponent. Must be 0 for a Receipts entry. */
  readonly valueDecimals: number;
  /**
   * 0 = free/human-verified, 1 = paid (human + receipt), 2 = wallet-verified.
   * Anything else fails closed. Type 2 is informational and never scores.
   */
  readonly reviewType: number;
  /**
   * The reviewing address, as the gateway recorded it. REQUIRED: it is the
   * only way to recognise a wallet-derived nullifier, so without it a type-0/1
   * review cannot be shown NOT to be a wallet identity and a type-2 one cannot
   * be shown to be one.
   *
   * The type makes omitting it a compile error; the engine ALSO fails closed
   * at runtime (`missing_reviewer` / `invalid_reviewer`), because a value can
   * reach here from untyped code or a cast. A review whose reviewer is absent
   * or malformed is excluded, never scored, so the wallet-nullifier defense
   * cannot be skipped by leaving the field out.
   */
  readonly reviewer: string;
  /** Gateway that emitted the review. Feedback indexes are per gateway. */
  readonly gateway?: string | undefined;
  /** Settled USDC amount in base units; required when reviewType is paid. */
  readonly paymentAmount?: bigint | undefined;
  /** True when the registry reports the entry revoked. */
  readonly revoked: boolean;
  /** 1-based index of the entry within the gateway's feedback history. */
  readonly feedbackIndex: bigint;
  /** Deterministic tiebreak for duplicate nullifiers: earliest wins. */
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

export type ExclusionReason =
  | 'revoked'
  | 'invalid_decimals'
  | 'rating_out_of_range'
  | 'unknown_review_type'
  | 'missing_payment'
  | 'duplicate_nullifier'
  | 'missing_reviewer'
  | 'invalid_reviewer'
  | 'wallet_nullifier_on_human_review'
  | 'invalid_wallet_nullifier';

export interface ExcludedReview {
  readonly nullifier: string;
  readonly feedbackIndex: bigint;
  readonly reason: ExclusionReason;
}

export interface EligibleReview {
  readonly nullifier: string;
  readonly value: bigint;
  readonly reviewType: number;
  readonly weight: bigint;
  readonly feedbackIndex: bigint;
  readonly gateway?: string | undefined;
}

/** A tier that can publish a score under its own distinct-human threshold. */
export interface ScoredTier {
  readonly score: bigint | null;
  readonly status: 'published' | 'below_threshold' | 'no_eligible_reviews';
  readonly count: number;
  readonly threshold: number;
  readonly totalWeight: bigint;
}

/** A counted wallet-verified review. Informational: it carries no weight. */
export interface WalletRecord {
  readonly nullifier: string;
  readonly value: bigint;
  readonly feedbackIndex: bigint;
  readonly gateway?: string | undefined;
}

/** Wallet reviews are reported, never scored. */
export interface WalletTier {
  readonly score: null;
  readonly status: 'informational';
  readonly count: number;
  readonly threshold: number;
  readonly totalWeight: bigint;
  readonly records: readonly WalletRecord[];
  readonly excluded: readonly ExcludedReview[];
}

export interface ReputationTiers {
  /** Types 0 and 1. Identical to the top-level legacy score. */
  readonly human: ScoredTier;
  /** Type 1 only. A subset of `human`: the categories overlap by design. */
  readonly receipt: ScoredTier;
  readonly wallet: WalletTier;
}

export interface ReputationResult {
  /** Null until the distinct-human threshold is met. Never a partial score. */
  readonly score: bigint | null;
  /** Why no score, when there is none. */
  readonly status: 'published' | 'below_threshold' | 'no_eligible_reviews';
  readonly eligible: readonly EligibleReview[];
  readonly excluded: readonly ExcludedReview[];
  readonly distinctHumans: number;
  readonly totalWeight: bigint;
  readonly humanVerifiedCount: number;
  readonly receiptVerifiedCount: number;
  readonly threshold: number;
  readonly tiers: ReputationTiers;
}

/**
 * Admit a review, or say why not.
 *
 * Order matters only for which reason is reported first; a review failing two
 * checks is excluded either way. Revocation is checked first because it is
 * the registry's own statement about the entry and outranks everything.
 */
function classify(review: ReviewInput): ExclusionReason | null {
  if (review.revoked) return 'revoked';
  if (review.valueDecimals !== REQUIRED_VALUE_DECIMALS) return 'invalid_decimals';
  if (review.value < MIN_RATING || review.value > MAX_RATING) return 'rating_out_of_range';
  if (review.reviewType !== REVIEW_TYPE_FREE && review.reviewType !== REVIEW_TYPE_PAID) {
    return 'unknown_review_type';
  }
  // A World ID review must carry a World ID nullifier. One derived from the
  // reviewer's address is a wallet identity posing as a human. The check needs
  // the reviewer, so a review without a usable one is excluded outright
  // instead of skipping the check.
  const reviewerIssue = reviewerProblem(review.reviewer);
  if (reviewerIssue !== null) return reviewerIssue;
  if (isWalletNullifier(review.nullifier, review.reviewer)) {
    return 'wallet_nullifier_on_human_review';
  }
  // A paid review whose receipt could not be read is unattributable: its
  // weight is unknown, and guessing 1.0 would let an unreadable receipt earn
  // the same standing as a verified free review.
  if (review.reviewType === REVIEW_TYPE_PAID) {
    if (review.paymentAmount === undefined || review.paymentAmount < 0n) return 'missing_payment';
  }
  return null;
}

/**
 * The reviewer check shared by every pool. Returns the reason a review cannot
 * be admitted for want of a usable reviewer, or null when the reviewer is a
 * well-formed address. Runs for every type so no path skips it.
 */
function reviewerProblem(reviewer: unknown): 'missing_reviewer' | 'invalid_reviewer' | null {
  if (reviewer === undefined || reviewer === null || reviewer === '') return 'missing_reviewer';
  if (typeof reviewer !== 'string' || !isAddress(reviewer, { strict: false })) {
    return 'invalid_reviewer';
  }
  return null;
}

/** Only call with a reviewer that passed `reviewerProblem`. */
function isWalletNullifier(nullifier: string, reviewer: string): boolean {
  return normalizeNullifier(nullifier) === walletNullifier(reviewer as Address).toLowerCase();
}

function weightOf(review: ReviewInput): bigint {
  if (review.reviewType === REVIEW_TYPE_PAID && review.paymentAmount !== undefined) {
    return paidWeight(review.paymentAmount);
  }
  return FREE_WEIGHT;
}

/**
 * The lower weighted median.
 *
 * Values are sorted ascending and weights accumulated; the result is the
 * first value whose cumulative weight satisfies `2 * cumulative >= total`.
 * Doubling rather than halving keeps the comparison in integers, so an odd
 * total weight has no rounding step to disagree about.
 *
 * "Lower" resolves the even/tied case deterministically: when the weight
 * splits exactly in half, the smaller of the two candidates is returned.
 * Interpolating would invent a value no reviewer gave.
 *
 * Ties in value need no tiebreak — equal values return the same result in
 * any order — but the sort is made total on (value, nullifier) anyway so the
 * evidence manifest is byte-identical across runs and machines.
 */
export function lowerWeightedMedian(
  entries: readonly { value: bigint; weight: bigint; nullifier: string }[],
): bigint | null {
  if (entries.length === 0) return null;

  const sorted = [...entries].sort((a, b) => {
    if (a.value !== b.value) return a.value < b.value ? -1 : 1;
    return a.nullifier < b.nullifier ? -1 : a.nullifier > b.nullifier ? 1 : 0;
  });

  let total = 0n;
  for (const entry of sorted) total += entry.weight;
  if (total <= 0n) return null;

  let cumulative = 0n;
  for (const entry of sorted) {
    cumulative += entry.weight;
    if (2n * cumulative >= total) return entry.value;
  }

  // Unreachable: the final cumulative equals total, so the test above holds.
  /* c8 ignore next */
  return sorted[sorted.length - 1]?.value ?? null;
}

/**
 * Score an agent from its candidate reviews.
 *
 * Duplicate nullifiers cannot occur through the protocol — `NullifierRegistry`
 * reverts the second consume for a (human, agent) pair — so a duplicate here
 * means the retrieval layer produced one, not that a human reviewed twice.
 * The earliest entry by (block, log index) is kept so the outcome does not
 * depend on retrieval order, and the later one is reported as excluded rather
 * than silently dropped.
 */
export function computeReputation(allReviews: readonly ReviewInput[]): ReputationResult {
  const excluded: ExcludedReview[] = [];

  // --- 0. Wallet reviews leave here, before anything can score ------------
  //
  // Partitioned by type before deduplication, eligibility, weighting or the
  // median, so there is no code path by which a wallet review can touch the
  // human score. Every other type -- including an unknown one -- stays in the
  // human pipeline, where classify() excludes whatever is not 0 or 1.
  const reviews = allReviews.filter((r) => r.reviewType !== REVIEW_TYPE_WALLET);
  const wallet = summarizeWallet(allReviews.filter((r) => r.reviewType === REVIEW_TYPE_WALLET));


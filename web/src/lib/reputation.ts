import type { ReputationResponse } from './api';

/**
 * Reading the additive `tiers` block of the reputation response.
 *
 * `human` and `receipt` overlap: a paid review is human-verified too, so it
 * counts in both. They are views of the same reviews, not parts of a whole,
 * and nothing here sums them.
 *
 * `wallet` is informational. Whatever the server sends for its score, this
 * client never exposes one: a wallet is not a person, so wallet reviews must
 * not read as reputation.
 */

export type TierStatus = 'published' | 'below_threshold' | 'no_eligible_reviews' | 'informational';

export interface ReputationTier {
  readonly score: number | null;
  readonly count: number;
  readonly threshold: number | null;
  readonly status: TierStatus | 'unknown';
  readonly totalWeight: string;
}

export interface ReputationTiers {
  readonly human: ReputationTier;
  readonly receipt: ReputationTier;
  readonly wallet: ReputationTier;
}

const STATUSES: readonly TierStatus[] = [
  'published',
  'below_threshold',
  'no_eligible_reviews',
  'informational',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTier(raw: unknown, kind: 'human' | 'receipt' | 'wallet'): ReputationTier | null {
  if (!isRecord(raw)) return null;

  const count = raw['count'];
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null;

  const status = STATUSES.find((candidate) => candidate === raw['status']) ?? 'unknown';
  const score = raw['score'];
  const threshold = raw['threshold'];
  const weight = raw['totalWeight'];

  return {
    // A wallet tier never has a score, whatever the payload says.
    score: kind === 'wallet' ? null : typeof score === 'number' ? score : null,
    count,
    threshold: typeof threshold === 'number' ? threshold : null,
    status,
    totalWeight: typeof weight === 'string' ? weight : '0',
  };
}

/**
 * Normalise `tiers`, or return null when it is absent or malformed.
 *
 * All three tiers must parse. A partial block is treated as no block, because
 * showing two panels and silently dropping a third would misrepresent the mix.
 */
export function readTiers(response: Pick<ReputationResponse, 'tiers'>): ReputationTiers | null {
  const raw = response.tiers;
  if (!isRecord(raw)) return null;

  const human = readTier(raw['human'], 'human');
  const receipt = readTier(raw['receipt'], 'receipt');
  const wallet = readTier(raw['wallet'], 'wallet');
  if (human === null || receipt === null || wallet === null) return null;

  return { human, receipt, wallet };
}

/**
 * "N verified humans".
 *
 * Always the top-level `distinct_humans`, which the server computes from
 * World ID nullifiers. The wallet tier's count is never part of it.
 */
export function verifiedHumanCount(response: Pick<ReputationResponse, 'distinct_humans'>): number {
  return response.distinct_humans;
}

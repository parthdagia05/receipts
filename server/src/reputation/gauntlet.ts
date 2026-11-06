import { computeReputation } from './engine.js';
import type { ReviewInput } from './engine.js';
import { REVIEW_TYPE_FREE } from './spec.js';

/**
 * The Monte Carlo attack gauntlet.
 *
 * Runs many synthetic attack scenarios through the REAL scoring engine and
 * tallies how often each scoring rule is corrupted. There is deliberately no
 * second implementation of the median here: every Receipts verdict comes from
 * the same `computeReputation` the live endpoint uses, so this page cannot
 * drift away from production behaviour. The registry mean is the same
 * floor-division arithmetic ERC-8004's `getSummary` performs on chain.
 *
 * Nothing here reads or writes chain state, and no attack is submitted
 * anywhere. The real-world anchor for the mean's behaviour is the mainnet-fork
 * experiment in `test/AttackLab.t.sol`, which this generalises.
 *
 * Determinism: all randomness comes from one seeded PRNG, so a given
 * (seed, trials) pair always produces byte-identical results.
 */

/** An attack "succeeds" when it moves a published score by at least this. */
export const SUCCESS_THRESHOLD = 5;

/** Generator bounds, reported back so the page can state them honestly. */
export const GENERATOR = {
  honestMin: 3,
  honestMax: 20,
  honestRatingMin: 40,
  honestRatingMax: 60,
  attackersMin: 1,
  attackersMax: 25,
  /** Attackers all push up (100) or all push down (0), per trial. */
  attackRatings: [0, 100] as const,
} as const;

export const DEFAULT_SEED = 8004;
export const MAX_TRIALS = 10_000;

/**
 * mulberry32: a tiny, well-known 32-bit seeded PRNG. Quality is far beyond
 * what a demo needs, and it is deterministic across platforms, which is the
 * property that matters here.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max], inclusive. */
function intBetween(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

/** One scenario: an honest population and an attacker gang. */
export interface GauntletTrial {
  readonly honestRatings: readonly number[];
  readonly attackerRatings: readonly number[];
}

export function generateTrial(rand: () => number): GauntletTrial {
  const honestCount = intBetween(rand, GENERATOR.honestMin, GENERATOR.honestMax);
  const honestRatings = Array.from({ length: honestCount }, () =>
    intBetween(rand, GENERATOR.honestRatingMin, GENERATOR.honestRatingMax),
  );

  const attackerCount = intBetween(rand, GENERATOR.attackersMin, GENERATOR.attackersMax);
  const attackRating = rand() < 0.5 ? 100 : 0;
  const attackerRatings = Array.from({ length: attackerCount }, () => attackRating);

  return { honestRatings, attackerRatings };
}

/**
 * Ratings as the engine's input type: free (human-verified) reviews from
 * distinct synthetic humans. The same construction the single-scenario
 * simulate endpoint uses; real nullifiers come from World ID and never
 * appear here. In the worst case modelled here every attacker holds a
 * verified World ID — reality also charges them one human per vote.
 */
function toInputs(ratings: readonly number[], offset: number): ReviewInput[] {
  return ratings.map((value, i) => {
    const index = offset + i;
    return {
      nullifier: `0xgauntlet${index.toString(16).padStart(8, '0')}`,
      reviewer: `0x${(index + 1).toString(16).padStart(40, '0')}`,
      value: BigInt(value),
      valueDecimals: 0,
      reviewType: REVIEW_TYPE_FREE,
      revoked: false,
      feedbackIndex: BigInt(index + 1),
      blockNumber: BigInt(index + 1),
      logIndex: 0,
    };
  });
}

/** The plain average ERC-8004's getSummary computes: floor(sum / count). */
function registryMean(ratings: readonly number[]): number {
  return Math.floor(ratings.reduce((sum, v) => sum + v, 0) / ratings.length);
}

export type MeanOutcome = 'corrupted' | 'protected';
export type MedianOutcome = 'corrupted' | 'protected' | 'withheld';

export interface TrialVerdict {
  readonly mean: MeanOutcome;
  readonly median: MedianOutcome;
  /**
   * Whether the attacked score left the range of honest ratings entirely —
   * a score no honest reviewer expressed. This is the strong notion of
   * corruption: a minority can shift a median between honest opinions, but
   * provably cannot push it past every honest voice; a mean has no such
   * bound. A withheld run has no score and therefore cannot escape.
   */
  readonly meanEscaped: boolean;
  readonly medianEscaped: boolean;
  /** Attackers' share of total reviewers; equals weight share (all weight 1). */
  readonly attackerShare: number;
}

/**
 * Score one trial under both rules, over the identical populations.
 *
 * Outcome rules, in the order they are checked:
 *  - attacked run below the five-human floor -> 'withheld'. Never counted as
 *    a defense: the system said nothing, it did not hold a score.
 *  - attacked run published where the honest baseline was withheld ->
 *    'corrupted': the attackers manufactured a score that would not exist.
 *  - both published -> 'corrupted' iff the score moved by at least
 *    SUCCESS_THRESHOLD, else 'protected'.
 *
 * The registry mean always publishes (the generator guarantees at least
 * three honest reviews), so it has only the corrupted/protected outcomes.
 */
export function judgeTrial(trial: GauntletTrial): TrialVerdict {
  const honest = trial.honestRatings;
  const all = [...trial.honestRatings, ...trial.attackerRatings];

  const honestMin = Math.min(...honest);
  const honestMax = Math.max(...honest);
  const escaped = (score: number): boolean => score < honestMin || score > honestMax;

  const baselineMeanScore = registryMean(honest);
  const attackedMeanScore = registryMean(all);
  const mean: MeanOutcome =
    Math.abs(attackedMeanScore - baselineMeanScore) >= SUCCESS_THRESHOLD
      ? 'corrupted'
      : 'protected';
  const meanEscaped = escaped(attackedMeanScore);

  const baseline = computeReputation(toInputs(honest, 0));
  const attacked = computeReputation(toInputs(all, 0));

  let median: MedianOutcome;
  let medianEscaped = false;
  if (attacked.status !== 'published' || attacked.score === null) {
    median = 'withheld';
  } else if (baseline.status !== 'published' || baseline.score === null) {
    median = 'corrupted';
    medianEscaped = escaped(Number(attacked.score));
  } else {
    median =
      Math.abs(Number(attacked.score) - Number(baseline.score)) >= SUCCESS_THRESHOLD
        ? 'corrupted'
        : 'protected';
    medianEscaped = escaped(Number(attacked.score));
  }

  const attackerShare = trial.attackerRatings.length / all.length;
  return { mean, median, meanEscaped, medianEscaped, attackerShare };
}

export interface SideTally {
  readonly corrupted: number;
  readonly protected: number;
  readonly withheld: number;
  /** Corruptions (moved >= threshold) with attackers UNDER half the weight. */
  readonly corruptedBelowHalfWeight: number;
  /** Trials whose attacked score left the honest rating range entirely. */
  readonly escaped: number;
  /** Escapes with attackers UNDER half the weight. Provably 0 for a median. */
  readonly escapedBelowHalfWeight: number;
}

export interface GauntletResult {
  readonly trials: number;
  readonly seed: number;
  readonly successThreshold: number;
  /** Trials in which attackers held under half the weight. The guarantee
   *  only speaks about these; a majority defeats any aggregation rule. */
  readonly minorityTrials: number;
  readonly mean: SideTally;
  readonly median: SideTally;
}

export function runGauntlet(trials: number, seed: number): GauntletResult {
  const rand = mulberry32(seed);

  let meanCorrupted = 0;
  let meanProtected = 0;
  let meanCorruptedMinority = 0;
  let meanEscaped = 0;
  let meanEscapedMinority = 0;
  let medianCorrupted = 0;
  let medianProtected = 0;
  let medianWithheld = 0;
  let medianCorruptedMinority = 0;
  let medianEscaped = 0;
  let medianEscapedMinority = 0;

  let minorityTrials = 0;

  for (let i = 0; i < trials; i++) {
    const verdict = judgeTrial(generateTrial(rand));
    const minority = verdict.attackerShare < 0.5;
    if (minority) minorityTrials++;

    if (verdict.mean === 'corrupted') {
      meanCorrupted++;
      if (minority) meanCorruptedMinority++;
    } else {
      meanProtected++;
    }
    if (verdict.meanEscaped) {
      meanEscaped++;
      if (minority) meanEscapedMinority++;
    }

    switch (verdict.median) {
      case 'corrupted':
        medianCorrupted++;
        if (minority) medianCorruptedMinority++;
        break;
      case 'protected':
        medianProtected++;
        break;
      case 'withheld':
        medianWithheld++;
        break;
    }
    if (verdict.medianEscaped) {
      medianEscaped++;
      if (minority) medianEscapedMinority++;
    }
  }

  return {
    trials,
    seed,
    successThreshold: SUCCESS_THRESHOLD,
    minorityTrials,
    mean: {
      corrupted: meanCorrupted,
      protected: meanProtected,
      withheld: 0,
      corruptedBelowHalfWeight: meanCorruptedMinority,
      escaped: meanEscaped,
      escapedBelowHalfWeight: meanEscapedMinority,
    },
    median: {
      corrupted: medianCorrupted,
      protected: medianProtected,
      withheld: medianWithheld,
      corruptedBelowHalfWeight: medianCorruptedMinority,
      escaped: medianEscaped,
      escapedBelowHalfWeight: medianEscapedMinority,
    },
  };
}

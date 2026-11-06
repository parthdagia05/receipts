import { describe, expect, it } from 'vitest';
import { computeReputation } from '../src/reputation/engine.js';
import type { ReviewInput } from '../src/reputation/engine.js';
import {
  DEFAULT_SEED,
  GENERATOR,
  SUCCESS_THRESHOLD,
  generateTrial,
  judgeTrial,
  mulberry32,
  runGauntlet,
} from '../src/reputation/gauntlet.js';
import { MIN_DISTINCT_HUMANS, REVIEW_TYPE_FREE } from '../src/reputation/spec.js';

/** The same construction gauntlet.ts uses, rebuilt independently here so the
 *  test can prove the gauntlet's verdicts match the production engine. */
function inputsFor(ratings: readonly number[]): ReviewInput[] {
  return ratings.map((value, index) => ({
    nullifier: `0xgauntlet${index.toString(16).padStart(8, '0')}`,
    reviewer: `0x${(index + 1).toString(16).padStart(40, '0')}`,
    value: BigInt(value),
    valueDecimals: 0,
    reviewType: REVIEW_TYPE_FREE,
    revoked: false,
    feedbackIndex: BigInt(index + 1),
    blockNumber: BigInt(index + 1),
    logIndex: 0,
  }));
}

describe('gauntlet determinism', () => {
  it('produces byte-identical results for the same seed and trial count', () => {
    const a = runGauntlet(500, DEFAULT_SEED);
    const b = runGauntlet(500, DEFAULT_SEED);
    expect(b).toEqual(a);
  });

  it('produces different tallies for a different seed', () => {
    const a = runGauntlet(500, DEFAULT_SEED);
    const b = runGauntlet(500, DEFAULT_SEED + 1);
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
  });

  it('generates trials deterministically from the PRNG', () => {
    const t1 = generateTrial(mulberry32(42));
    const t2 = generateTrial(mulberry32(42));
    expect(t2).toEqual(t1);
  });
});

describe('gauntlet generator bounds', () => {
  it('stays inside the documented population and rating ranges', () => {
    const rand = mulberry32(DEFAULT_SEED);
    for (let i = 0; i < 1_000; i++) {
      const trial = generateTrial(rand);
      expect(trial.honestRatings.length).toBeGreaterThanOrEqual(GENERATOR.honestMin);
      expect(trial.honestRatings.length).toBeLessThanOrEqual(GENERATOR.honestMax);
      expect(trial.attackerRatings.length).toBeGreaterThanOrEqual(GENERATOR.attackersMin);
      expect(trial.attackerRatings.length).toBeLessThanOrEqual(GENERATOR.attackersMax);
      for (const v of trial.honestRatings) {
        expect(v).toBeGreaterThanOrEqual(GENERATOR.honestRatingMin);
        expect(v).toBeLessThanOrEqual(GENERATOR.honestRatingMax);
      }
      // All attackers in one trial push in the same direction.
      const distinct = new Set(trial.attackerRatings);
      expect(distinct.size).toBe(1);
      const rating = trial.attackerRatings[0];
      expect(GENERATOR.attackRatings).toContain(rating);
    }
  });
});

describe('gauntlet verdicts against the production engine', () => {
  it('scores the canonical scenario: mean corrupted, median protected', () => {
    // 5 honest at 50, 4 attackers at 100 — the AttackLab shape.
    const verdict = judgeTrial({
      honestRatings: [50, 50, 50, 50, 50],
      attackerRatings: [100, 100, 100, 100],
    });
    // mean: floor(650/9) = 72, moved 22 points.
    expect(verdict.mean).toBe('corrupted');
    // median: still 50, moved 0 points.
    expect(verdict.median).toBe('protected');
    expect(verdict.attackerShare).toBeCloseTo(4 / 9);
  });

  it('matches a direct computeReputation call on the identical population', () => {
    const honest = [41, 55, 60, 47, 52, 58];
    const attackers = [100, 100, 100, 100, 100];
    const all = [...honest, ...attackers];

    const direct = computeReputation(inputsFor(all));
    const directBaseline = computeReputation(inputsFor(honest));
    expect(direct.status).toBe('published');
    expect(directBaseline.status).toBe('published');

    const expected =
      Math.abs(Number(direct.score) - Number(directBaseline.score)) >= SUCCESS_THRESHOLD
        ? 'corrupted'
        : 'protected';

    const verdict = judgeTrial({ honestRatings: honest, attackerRatings: attackers });
    expect(verdict.median).toBe(expected);
  });

  it('judges both rules over the identical input populations', () => {
    // A trial where the two rules disagree is only meaningful if both saw the
    // same reviews: the mean of honest+attackers moved, the median did not.
    const honest = [50, 50, 50, 50, 50, 50, 50];
    const attackers = [100, 100, 100];
    const verdict = judgeTrial({ honestRatings: honest, attackerRatings: attackers });
    // floor(650/10) = 65 vs 50: moved 15.
    expect(verdict.mean).toBe('corrupted');
    // Median of ten values, seven of them 50: still 50.
    expect(verdict.median).toBe('protected');
  });
});

describe('gauntlet threshold edges', () => {
  it('reports withheld when the attacked run stays under five humans', () => {
    const verdict = judgeTrial({ honestRatings: [50, 50, 50], attackerRatings: [100] });
    expect(3 + 1).toBeLessThan(MIN_DISTINCT_HUMANS);
    expect(verdict.median).toBe('withheld');
    expect(verdict.median).not.toBe('protected');
  });

  it('reports corrupted when attackers mint a score the honest baseline lacked', () => {
    // 4 honest: baseline withheld. 6 attackers push the count past the floor,
    // so a score exists only because of the attack.
    const verdict = judgeTrial({
      honestRatings: [50, 50, 50, 50],
      attackerRatings: [100, 100, 100, 100, 100, 100],
    });
    expect(verdict.median).toBe('corrupted');
  });

  it('publishes at exactly the five-human floor', () => {
    const verdict = judgeTrial({
      honestRatings: [50, 50, 50, 50, 50],
      attackerRatings: [],
    });
    expect(verdict.median).toBe('protected');
  });
});

describe('gauntlet success threshold boundary', () => {
  it('counts a move of exactly five points as corrupted', () => {
    // mean: floor((250 + 80) / 6) = 55 — moved exactly 5.
    const verdict = judgeTrial({ honestRatings: [50, 50, 50, 50, 50], attackerRatings: [80] });
    expect(verdict.mean).toBe('corrupted');
    expect(verdict.median).toBe('protected'); // median still 50
  });

  it('counts a move of four points as protected', () => {
    // mean: floor((250 + 74) / 6) = 54 — moved 4.
    const verdict = judgeTrial({ honestRatings: [50, 50, 50, 50, 50], attackerRatings: [74] });
    expect(verdict.mean).toBe('protected');
  });
});

describe('gauntlet accounting', () => {
  it('splits every trial into exactly one outcome per side', () => {
    const result = runGauntlet(2_000, DEFAULT_SEED);

    expect(result.mean.corrupted + result.mean.protected + result.mean.withheld).toBe(
      result.trials,
    );
    expect(result.median.corrupted + result.median.protected + result.median.withheld).toBe(
      result.trials,
    );
    // The registry mean has no publication threshold, so nothing is withheld.
    expect(result.mean.withheld).toBe(0);
    // The generator guarantees honest >= 3 and attackers >= 1, so withheld
    // trials exist (3 or 4 total reviewers) and must not inflate "protected".
    expect(result.median.withheld).toBeGreaterThan(0);
  });

  it('never lets a minority push the median past every honest rating', () => {
    const result = runGauntlet(5_000, DEFAULT_SEED);
    // The provable bound: below half the weight, a weighted median stays
    // within the range of honest ratings. It can shift BETWEEN honest
    // opinions (counted in corrupted_below_half_weight), never beyond them.
    expect(result.median.escapedBelowHalfWeight).toBe(0);
    // The mean has no such bound and leaves the honest range constantly.
    expect(result.mean.escapedBelowHalfWeight).toBeGreaterThan(0);
    // Honesty check on the weaker metric: a minority CAN move the median by
    // five points within the honest spread, and the tally must say so rather
    // than hide it.
    expect(result.median.corruptedBelowHalfWeight).toBeGreaterThan(0);
    expect(result.mean.corruptedBelowHalfWeight).toBeGreaterThan(
      result.median.corruptedBelowHalfWeight,
    );
  });

  it('distinguishes a shift within honest opinion from an escape beyond it', () => {
    // Honest opinion split 40 vs 60; five attackers at 100 hold 5/11 < half.
    const verdict = judgeTrial({
      honestRatings: [40, 40, 40, 60, 60, 60],
      attackerRatings: [100, 100, 100, 100, 100],
    });
    // The median moves 40 -> 60: a 20-point shift, so 'corrupted' under the
    // five-point metric — but 60 is an honest rating, so it did NOT escape.
    expect(verdict.median).toBe('corrupted');
    expect(verdict.medianEscaped).toBe(false);
    // The mean lands at floor(800/11) = 72, beyond every honest voice.
    expect(verdict.mean).toBe('corrupted');
    expect(verdict.meanEscaped).toBe(true);
  });

  it('runs the full ten-thousand-trial batch in reasonable time', () => {
    const start = Date.now();
    const result = runGauntlet(10_000, DEFAULT_SEED);
    const elapsed = Date.now() - start;
    expect(result.trials).toBe(10_000);
    expect(elapsed).toBeLessThan(20_000);
  });
});

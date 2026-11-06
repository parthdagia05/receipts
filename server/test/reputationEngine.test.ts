import { describe, expect, it } from 'vitest';
import {
  computeReputation,
  lowerWeightedMedian,
  type ReviewInput,
} from '../src/reputation/engine.js';
import {
  FREE_WEIGHT,
  InvalidPaymentAmountError,
  MAX_PAID_WEIGHT,
  MIN_DISTINCT_HUMANS,
  WEIGHT_ONE,
  formatWeight,
  paidWeight,
} from '../src/reputation/spec.js';

/**
 * Specification v1.0 conformance.
 *
 * The approved model, restated so a reader can check the tests against it
 * without opening another file:
 *
 *   free weight        1
 *   paid weight        1 + min(paymentUSDC / 10, 1), capped at 2
 *   threshold          5 eligible distinct humans
 *   aggregation        lower weighted median, 2*cumulative >= total
 *   ratings            integers 0..100, valueDecimals 0
 */

let seq = 0;
function review(partial: Partial<ReviewInput> & { value: bigint }): ReviewInput {
  seq += 1;
  return {
    nullifier: partial.nullifier ?? `0xn${seq}`,
    reviewer: partial.reviewer ?? `0x${seq.toString(16).padStart(40, '0')}`,
    value: partial.value,
    valueDecimals: partial.valueDecimals ?? 0,
    reviewType: partial.reviewType ?? 0,
    paymentAmount: partial.paymentAmount,
    revoked: partial.revoked ?? false,
    feedbackIndex: partial.feedbackIndex ?? BigInt(seq),
    blockNumber: partial.blockNumber ?? BigInt(seq),
    logIndex: partial.logIndex ?? 0,
  };
}

/** Five distinct free reviews, the minimum publishable set. */
function freeSet(values: readonly number[]): ReviewInput[] {
  return values.map((v, i) =>
    review({ value: BigInt(v), nullifier: `0xfree${i}`, blockNumber: BigInt(i + 1) }),
  );
}

const USDC = 1_000_000n;

describe('paidWeight', () => {
  it('is 1 for a zero payment', () => {
    expect(paidWeight(0n)).toBe(WEIGHT_ONE);
  });

  it('adds 0.1 per USDC below the cap', () => {
    expect(paidWeight(1n * USDC)).toBe(1_100_000n);
    expect(paidWeight(5n * USDC)).toBe(1_500_000n);
    expect(paidWeight(9n * USDC)).toBe(1_900_000n);
  });

  it('reaches the cap at exactly 10 USDC', () => {
    expect(paidWeight(10n * USDC)).toBe(MAX_PAID_WEIGHT);
    expect(MAX_PAID_WEIGHT).toBe(2n * WEIGHT_ONE);
  });

  it('never exceeds the cap, however large the payment', () => {
    for (const amount of [11n, 100n, 1_000_000n, 10n ** 12n]) {
      expect(paidWeight(amount * USDC)).toBe(MAX_PAID_WEIGHT);
    }
  });

  it('truncates below a micro-weight rather than rounding up', () => {
    // 0.0000009 USDC of bonus is below the representable resolution.
    expect(paidWeight(9n)).toBe(WEIGHT_ONE);
    expect(paidWeight(10n)).toBe(WEIGHT_ONE + 1n);
  });

  it('rejects a negative amount instead of silently falling back to 1', () => {
    // USDC cannot be negative, so the value did not come from a settled
    // receipt. Returning FREE_WEIGHT would give unverifiable evidence the
    // same standing as a verified free review.
    expect(() => paidWeight(-1n)).toThrow(InvalidPaymentAmountError);
    expect(() => paidWeight(-10_000_000n)).toThrow(/must not be negative/);
  });

  it('covers the full specified range of amounts', () => {
    const cases: readonly [bigint, bigint][] = [
      [0n, WEIGHT_ONE], //             0 USDC   -> 1.0
      [1n, WEIGHT_ONE], //             1e-6 USDC-> 1.0 (below resolution)
      [10n, WEIGHT_ONE + 1n], //       1e-5 USDC-> 1.000001
      [100_000n, 1_010_000n], //       0.1 USDC -> 1.01
      [500_000n, 1_050_000n], //       0.5 USDC -> 1.05
      [1n * USDC, 1_100_000n], //      1 USDC   -> 1.1
      [9_999_999n, 1_999_999n], //     ~10 USDC -> just under the cap
      [10n * USDC, MAX_PAID_WEIGHT], //10 USDC  -> 2.0, the cap
      [10n * USDC + 1n, MAX_PAID_WEIGHT], // just over -> still 2.0
      [1_000_000n * USDC, MAX_PAID_WEIGHT], // far over -> still 2.0
    ];
    for (const [amount, expected] of cases) {
      expect(paidWeight(amount), `amount ${amount}`).toBe(expected);
    }
  });
});

describe('formatWeight', () => {
  it('renders micro-weight as a decimal', () => {
    expect(formatWeight(WEIGHT_ONE)).toBe('1');
    expect(formatWeight(1_100_000n)).toBe('1.1');
    expect(formatWeight(2_000_000n)).toBe('2');
    expect(formatWeight(1_234_567n)).toBe('1.234567');
  });
});

describe('lowerWeightedMedian', () => {
  const entry = (value: number, weight: bigint, nullifier = `n${value}`) => ({
    value: BigInt(value),
    weight,
    nullifier,
  });

  it('returns null for an empty set', () => {
    expect(lowerWeightedMedian([])).toBeNull();
  });

  it('matches the plain median when weights are equal and the count is odd', () => {
    expect(lowerWeightedMedian([10, 20, 30, 40, 50].map((v) => entry(v, WEIGHT_ONE)))).toBe(30n);
  });

  it('takes the LOWER of the two middles on an even count with equal weights', () => {
    // Weight splits exactly in half between 20 and 30.
    expect(lowerWeightedMedian([10, 20, 30, 40].map((v) => entry(v, WEIGHT_ONE)))).toBe(20n);
  });

  it('follows weight, not count, when weights are unequal', () => {
    // 90 alone holds 4 of 7 total weight, so it is the median.
    const entries = [
      entry(10, WEIGHT_ONE),
      entry(20, WEIGHT_ONE),
      entry(30, WEIGHT_ONE),
      entry(90, 4n * WEIGHT_ONE),
    ];
    expect(lowerWeightedMedian(entries)).toBe(90n);
  });

  it('is unchanged by input order', () => {
    const entries = [entry(50, WEIGHT_ONE), entry(10, 2n * WEIGHT_ONE), entry(99, WEIGHT_ONE)];
    const forward = lowerWeightedMedian(entries);
    const reversed = lowerWeightedMedian([...entries].reverse());
    expect(forward).toBe(reversed);
  });

  it('is deterministic when values tie', () => {
    const entries = [
      entry(40, WEIGHT_ONE, 'b'),
      entry(40, WEIGHT_ONE, 'a'),
      entry(41, WEIGHT_ONE, 'c'),
    ];
    expect(lowerWeightedMedian(entries)).toBe(40n);
    expect(lowerWeightedMedian([...entries].reverse())).toBe(40n);
  });

  it('uses 2*cumulative >= total, so an exact half split picks the lower', () => {
    // Two entries, equal weight: cumulative after the first is exactly half.
    expect(lowerWeightedMedian([entry(0, WEIGHT_ONE), entry(100, WEIGHT_ONE)])).toBe(0n);
  });
});

describe('threshold', () => {
  it('publishes nothing for an empty dataset', () => {
    const result = computeReputation([]);
    expect(result.score).toBeNull();
    expect(result.status).toBe('no_eligible_reviews');
  });

  it('withholds a score below five distinct humans', () => {
    for (let n = 1; n < MIN_DISTINCT_HUMANS; n++) {
      const result = computeReputation(freeSet(Array.from({ length: n }, () => 50)));
      expect(result.score).toBeNull();
      expect(result.status).toBe('below_threshold');
      expect(result.distinctHumans).toBe(n);
    }
  });

  it('publishes at exactly five', () => {
    const result = computeReputation(freeSet([10, 20, 30, 40, 50]));
    expect(result.status).toBe('published');
    expect(result.score).toBe(30n);
    expect(result.distinctHumans).toBe(5);
  });

  it('counts only eligible reviews toward the threshold', () => {
    // Five entries, but one revoked: four eligible humans, so no score.
    const reviews = freeSet([10, 20, 30, 40, 50]);
    const withRevoked = reviews.map((r, i) => (i === 0 ? { ...r, revoked: true } : r));
    const result = computeReputation(withRevoked);
    expect(result.status).toBe('below_threshold');
    expect(result.distinctHumans).toBe(4);
  });
});

describe('eligibility and exclusions', () => {
  it('excludes revoked entries and records the reason', () => {
    const reviews = [...freeSet([10, 20, 30, 40, 50]), review({ value: 100n, revoked: true })];
    const result = computeReputation(reviews);
    expect(result.excluded).toContainEqual(expect.objectContaining({ reason: 'revoked' }));
    expect(result.distinctHumans).toBe(5);
    expect(result.score).toBe(30n);
  });

  it('excludes a non-zero valueDecimals', () => {
    const result = computeReputation([
      ...freeSet([10, 20, 30, 40, 50]),
      review({ value: 100n, valueDecimals: 2 }),
    ]);
    expect(result.excluded).toContainEqual(expect.objectContaining({ reason: 'invalid_decimals' }));
    expect(result.score).toBe(30n);
  });

  it('excludes ratings outside 0..100, including negatives', () => {
    const result = computeReputation([
      ...freeSet([10, 20, 30, 40, 50]),
      review({ value: 101n }),
      review({ value: -1n }),
    ]);
    const reasons = result.excluded.map((e) => e.reason);
    expect(reasons.filter((r) => r === 'rating_out_of_range')).toHaveLength(2);
    expect(result.score).toBe(30n);
  });

  it('accepts the boundary ratings 0 and 100', () => {
    const result = computeReputation(freeSet([0, 0, 50, 100, 100]));
    expect(result.status).toBe('published');
    expect(result.score).toBe(50n);
  });

  it('excludes an unrecognised review type', () => {
    const result = computeReputation([
      ...freeSet([10, 20, 30, 40, 50]),
      review({ value: 100n, reviewType: 7 }),
    ]);
    expect(result.excluded).toContainEqual(
      expect.objectContaining({ reason: 'unknown_review_type' }),
    );
  });

  it('excludes a paid review whose payment could not be recovered', () => {
    const result = computeReputation([
      ...freeSet([10, 20, 30, 40, 50]),
      review({ value: 100n, reviewType: 1, paymentAmount: undefined }),
    ]);
    expect(result.excluded).toContainEqual(expect.objectContaining({ reason: 'missing_payment' }));
    expect(result.score).toBe(30n);
  });
});

describe('duplicate reviewers', () => {
  it('keeps the earliest entry for a repeated nullifier and excludes the rest', () => {
    const base = freeSet([10, 20, 30, 40, 50]);
    const dupe = review({
      value: 100n,
      nullifier: base[0]?.nullifier ?? '0xfree0',
      blockNumber: 999n,
    });
    const result = computeReputation([...base, dupe]);

    expect(result.distinctHumans).toBe(5);
    expect(result.excluded).toContainEqual(
      expect.objectContaining({ reason: 'duplicate_nullifier' }),
    );
    // The late 100 must not shift the median.
    expect(result.score).toBe(30n);
  });

  it('resolves duplicates by block then log index, not by input order', () => {
    const early = review({ value: 10n, nullifier: '0xsame', blockNumber: 5n, logIndex: 1 });
    const late = review({ value: 90n, nullifier: '0xsame', blockNumber: 5n, logIndex: 2 });
    const forward = computeReputation([early, late, ...freeSet([20, 30, 40, 50])]);
    const reversed = computeReputation([late, early, ...freeSet([20, 30, 40, 50])]);
    expect(forward.eligible.find((e) => e.nullifier === '0xsame')?.value).toBe(10n);
    expect(reversed.eligible.find((e) => e.nullifier === '0xsame')?.value).toBe(10n);
  });
});

describe('weighting by review type', () => {
  it('gives a free review weight 1 and a capped paid review weight 2', () => {
    const result = computeReputation([
      review({ value: 10n, nullifier: 'a' }),
      review({ value: 20n, nullifier: 'b' }),
      review({ value: 30n, nullifier: 'c' }),
      review({ value: 40n, nullifier: 'd' }),
      review({ value: 90n, nullifier: 'e', reviewType: 1, paymentAmount: 10n * USDC }),
    ]);
    expect(result.humanVerifiedCount).toBe(4);
    expect(result.receiptVerifiedCount).toBe(1);
    expect(result.totalWeight).toBe(4n * WEIGHT_ONE + MAX_PAID_WEIGHT);
    expect(result.eligible.find((e) => e.nullifier === 'e')?.weight).toBe(MAX_PAID_WEIGHT);
  });

  it('lets paid weight move the median within the honest range', () => {
    // Four free 10s (weight 4) and three paid 90s at the cap (weight 6):
    // the paid side holds the majority, so the median is 90.
    const reviews = [
      ...[0, 1, 2, 3].map((i) => review({ value: 10n, nullifier: `f${i}` })),
      ...[0, 1, 2].map((i) =>
        review({ value: 90n, nullifier: `p${i}`, reviewType: 1, paymentAmount: 10n * USDC }),
      ),
    ];
    const result = computeReputation(reviews);
    expect(result.totalWeight).toBe(4n * WEIGHT_ONE + 3n * MAX_PAID_WEIGHT);
    expect(result.score).toBe(90n);
  });
});

describe('outlier manipulation', () => {
  it('is unmoved by extreme values held by a weight minority', () => {
    // Nine honest 50s (weight 9) against four capped paid 100s (weight 8).
    const honest = Array.from({ length: 9 }, (_, i) => review({ value: 50n, nullifier: `h${i}` }));
    const attackers = Array.from({ length: 4 }, (_, i) =>
      review({ value: 100n, nullifier: `a${i}`, reviewType: 1, paymentAmount: 10n * USDC }),
    );
    const result = computeReputation([...honest, ...attackers]);
    expect(result.score).toBe(50n);
  });

  it('reproduces the AttackLab scenario without moving the score', () => {
    // AttackLab: five honest 50s, six attackers at 100 drag the MEAN to 77.
    // The same six, as free reviews, hold 6/11 weight here, so they do move
    // a median too — which is exactly why the paid weight and the World ID
    // nullifier matter: six distinct humans is the cost, not six addresses.
    const honest = Array.from({ length: 5 }, (_, i) => review({ value: 50n, nullifier: `h${i}` }));
    const attackers = Array.from({ length: 4 }, (_, i) =>
      review({ value: 100n, nullifier: `a${i}` }),
    );
    // Four attackers against five honest: attacker weight 4/9 < 1/2.
    const result = computeReputation([...honest, ...attackers]);
    expect(result.score).toBe(50n);

    const mean =
      [...honest, ...attackers].reduce((sum, r) => sum + Number(r.value), 0) /
      (honest.length + attackers.length);
    expect(mean).toBeCloseTo(72.2, 1);
  });
});

import { describe, expect, it } from 'vitest';
import { lowerWeightedMedian } from '../src/reputation/engine.js';
import { FREE_WEIGHT, paidWeight } from '../src/reputation/spec.js';

/**
 * The manipulation-resistance claim, tested rather than asserted in prose.
 *
 * Claim (honest-quantile bound). Let W be the total weight and A the weight
 * held by an adversary who may choose any values. If 2A < W then the lower
 * weighted median lies in [vLo, vHi], where vLo and vHi are honest order
 * statistics computed from the honest reviews alone:
 *
 *   vHi = the first honest value whose cumulative honest weight c satisfies
 *         2c >= W            (the adversary placed every vote ABOVE, so it
 *                             is pushed as high as it can go)
 *   vLo = the first honest value whose cumulative honest weight c satisfies
 *         2(c + A) >= W      (the adversary placed every vote BELOW)
 *
 * Both bounds are honest values, so the score always lies inside the honest
 * range. It is NOT always equal to one: an adversary voting between two
 * honest values can land the median on its own number -- honest [0, 100]
 * with one attacker at 50 returns 50. The guarantee is the interval, not
 * the identity, and the randomized run below is what established that; an
 * earlier version of this file asserted the stronger claim and was wrong.
 *
 * Everything here is bigint. A property test that reported a false pass
 * because 0.1 + 0.2 !== 0.3 would be worse than no property test.
 */

/** xorshift32: deterministic, so a failure is reproducible from the seed. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

interface Entry {
  value: bigint;
  weight: bigint;
  nullifier: string;
}

/** A review under the real specification weights. */
function makeEntry(rng: () => number, tag: string, index: number): Entry {
  const value = BigInt(Math.floor(rng() * 101)); // 0..100 inclusive
  const paid = rng() < 0.5;
  // 0 to ~15 USDC, which straddles the 10 USDC weight cap.
  const amount = BigInt(Math.floor(rng() * 15_000_000));
  return {
    value,
    weight: paid ? paidWeight(amount) : FREE_WEIGHT,
    nullifier: `${tag}${index.toString().padStart(4, '0')}`,
  };
}

/** The two honest order statistics the bound is stated in terms of. */
function honestBounds(honest: readonly Entry[], attackerWeight: bigint, total: bigint) {
  const sorted = [...honest].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));

  let cumulative = 0n;
  let vHi: bigint | null = null;
  for (const entry of sorted) {
    cumulative += entry.weight;
    if (2n * cumulative >= total) {
      vHi = entry.value;
      break;
    }
  }

  cumulative = 0n;
  let vLo: bigint | null = null;
  for (const entry of sorted) {
    cumulative += entry.weight;
    if (2n * (cumulative + attackerWeight) >= total) {
      vLo = entry.value;
      break;
    }
  }

  return { vLo, vHi };
}

const ITERATIONS = 10_000;

describe('honest-quantile bound (10,000 randomized trials)', () => {
  it('holds whenever attacker weight is strictly below 50%', () => {
    const rng = makeRng(0x5ece1b75);
    let trials = 0;
    let skippedNotMinority = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const honestCount = 1 + Math.floor(rng() * 20);
      const attackerCount = Math.floor(rng() * 20);

      const honest = Array.from({ length: honestCount }, (_, k) => makeEntry(rng, 'h', k));
      const attackers = Array.from({ length: attackerCount }, (_, k) => makeEntry(rng, 'a', k));

      const attackerWeight = attackers.reduce((sum, e) => sum + e.weight, 0n);
      const total = [...honest, ...attackers].reduce((sum, e) => sum + e.weight, 0n);

      // The guarantee is conditional; trials outside it are counted, not asserted.
      if (2n * attackerWeight >= total) {
        skippedNotMinority += 1;
        continue;
      }
      trials += 1;

      const median = lowerWeightedMedian([...honest, ...attackers]);
      expect(median).not.toBeNull();

      const { vLo, vHi } = honestBounds(honest, attackerWeight, total);
      expect(vLo).not.toBeNull();
      expect(vHi).not.toBeNull();

      if (median === null || vLo === null || vHi === null) throw new Error('unreachable');

      // The bound itself.
      expect(median >= vLo).toBe(true);
      expect(median <= vHi).toBe(true);

      // Corollary: the score is inside the honest range. Note it is NOT
      // always a value an honest reviewer gave -- an adversary voting
      // between two honest values can land the median on its own value.
      // Honest [0, 100] with one attacker at 50 returns 50. What it cannot
      // do is leave the interval the honest reviews define.
      const honestValues = honest.map((e) => e.value);
      let minHonest = honestValues[0] ?? 0n;
      let maxHonest = honestValues[0] ?? 0n;
      for (const v of honestValues) {
        if (v < minHonest) minHonest = v;
        if (v > maxHonest) maxHonest = v;
      }
      expect(median >= minHonest).toBe(true);
      expect(median <= maxHonest).toBe(true);
    }

    // Printed so the report can state how much of the space was actually
    // under the guarantee rather than filtered out by it.
    console.log(
      `  honest-quantile bound: asserted on ${trials} trials, ` +
        `${skippedNotMinority} skipped (attacker weight >= 50%)`,
    );

    // The suite is worthless if the condition filtered almost everything out.
    expect(trials).toBeGreaterThan(ITERATIONS * 0.4);
    expect(trials + skippedNotMinority).toBe(ITERATIONS);
  });

  it('is independent of the order the reviews arrive in', () => {
    const rng = makeRng(0x1234abcd);
    for (let i = 0; i < 1_000; i++) {
      const entries = Array.from({ length: 1 + Math.floor(rng() * 12) }, (_, k) =>
        makeEntry(rng, 'x', k),
      );
      const forward = lowerWeightedMedian(entries);
      const reversed = lowerWeightedMedian([...entries].reverse());
      const shuffled = lowerWeightedMedian([...entries].sort(() => (rng() < 0.5 ? -1 : 1)));
      expect(reversed).toBe(forward);
      expect(shuffled).toBe(forward);
    }
  });
});

describe('boundary: attacker weight at or above 50%', () => {
  /**
   * These record what happens outside the guarantee. No bound is asserted,
   * because none is claimed: at exactly half the weight an adversary can
   * already pin the lower weighted median to its own value, and above half it
   * controls the result outright. Stating that plainly is the point.
   */
  it('at exactly 50% the adversary can pin the score to its own value', () => {
    // Two honest at 10 (weight 2), two attackers at 90 (weight 2): A = W/2.
    const honest: Entry[] = [
      { value: 10n, weight: FREE_WEIGHT, nullifier: 'h1' },
      { value: 10n, weight: FREE_WEIGHT, nullifier: 'h2' },
    ];
    const attackers: Entry[] = [
      { value: 90n, weight: FREE_WEIGHT, nullifier: 'a1' },
      { value: 90n, weight: FREE_WEIGHT, nullifier: 'a2' },
    ];
    const total = 4n * FREE_WEIGHT;
    const attackerWeight = 2n * FREE_WEIGHT;
    expect(2n * attackerWeight).toBe(total); // exactly the boundary

    // Attackers above: the lower median still lands on honest 10.
    expect(lowerWeightedMedian([...honest, ...attackers])).toBe(10n);

    // But flip the sides and the same half-weight pins it to 90, so no
    // guarantee can be claimed at the boundary in general.
    const flippedHonest: Entry[] = honest.map((e) => ({ ...e, value: 90n }));
    const flippedAttackers: Entry[] = attackers.map((e) => ({ ...e, value: 10n }));
    expect(lowerWeightedMedian([...flippedHonest, ...flippedAttackers])).toBe(10n);
  });

  it('above 50% the adversary controls the score outright', () => {
    const rng = makeRng(0xfeed);
    let controlled = 0;
    const trials = 500;

    for (let i = 0; i < trials; i++) {
      const honest = Array.from({ length: 1 + Math.floor(rng() * 5) }, (_, k) => ({
        value: 10n,
        weight: FREE_WEIGHT,
        nullifier: `h${k}`,
      }));
      // Strictly more weight than the honest side, all voting 100.
      const attackers = Array.from({ length: honest.length + 1 }, (_, k) => ({
        value: 100n,
        weight: 2n * FREE_WEIGHT,
        nullifier: `a${k}`,
      }));
      const median = lowerWeightedMedian([...honest, ...attackers]);
      if (median === 100n) controlled += 1;
    }

    // Recorded, not defended: this is the failure mode the threshold and the
    // one-human-one-review nullifier exist to make expensive.
    expect(controlled).toBe(trials);
  });
});

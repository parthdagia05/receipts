import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { buildManifest, canonicalJson, manifestHash } from '../src/reputation/evidence.js';
import { computeReputation, type ReviewInput } from '../src/reputation/engine.js';
import { SPEC_VERSION } from '../src/reputation/spec.js';

const CONTRACTS = {
  reviewGateway: '0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD',
  receiptSettler: '0xC3AA7a2F43d83680f9E0B97e0Eb4fD01E421ceDe',
  identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
} as const;

function review(value: number, index: number, over: Partial<ReviewInput> = {}): ReviewInput {
  return {
    nullifier: `0xnull${index}`,
    reviewer: `0x${(index + 1).toString(16).padStart(40, '0')}`,
    value: BigInt(value),
    valueDecimals: 0,
    reviewType: 0,
    revoked: false,
    feedbackIndex: BigInt(index + 1),
    blockNumber: BigInt(100 + index),
    logIndex: 0,
    ...over,
  };
}

const SET = [10, 20, 30, 40, 50].map((v, i) => review(v, i));

function manifestFor(reviews: readonly ReviewInput[]) {
  return buildManifest({
    agentId: 11265n,
    chainId: 11155111,
    snapshotBlock: 12_064_002n,
    contracts: CONTRACTS,
    result: computeReputation(reviews),
  });
}

describe('canonicalJson', () => {
  it('sorts object keys at every level', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it('produces identical output for objects built in different key orders', () => {
    const forward = canonicalJson({ one: 1, two: 2, three: 3 });
    const reverse = canonicalJson({ three: 3, two: 2, one: 1 });
    expect(forward).toBe(reverse);
  });

  it('preserves array order, which carries meaning', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined members rather than emitting null for them', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalJson({ a: [1, 2], b: 'x' })).toBe('{"a":[1,2],"b":"x"}');
  });

  it('refuses a bigint, which has no canonical JSON form', () => {
    expect(() => canonicalJson({ a: 1n })).toThrow(/bigint/);
  });

  it('refuses a non-integer or non-finite number', () => {
    expect(() => canonicalJson(1.5)).toThrow(/non-integer/);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });
});

describe('manifest', () => {
  it('records the spec version, snapshot block and every contract read', () => {
    const manifest = manifestFor(SET);
    expect(manifest.spec).toBe(SPEC_VERSION);
    expect(manifest.snapshotBlock).toBe('12064002');
    expect(manifest.chainId).toBe(11155111);
    expect(manifest.contracts).toEqual(CONTRACTS);
  });

  it('renders every integer as a decimal string', () => {
    const manifest = manifestFor(SET);
    expect(manifest.score).toBe('30');
    expect(manifest.totalWeight).toBe('5000000');
    expect(manifest.eligible[0]?.value).toBe('10');
    expect(manifest.eligible[0]?.weight).toBe('1000000');
    expect(manifest.eligible[0]?.weightDecimal).toBe('1');
  });

  it('carries a null score and a reason below the threshold', () => {
    const manifest = manifestFor(SET.slice(0, 3));
    expect(manifest.score).toBeNull();
    expect(manifest.status).toBe('below_threshold');
    expect(manifest.distinctHumans).toBe(3);
    expect(manifest.threshold).toBe(5);
  });

  it('lists exclusions with their reasons so a reader can audit them', () => {
    const manifest = manifestFor([...SET, review(100, 9, { revoked: true })]);
    expect(manifest.excluded).toContainEqual({
      nullifier: '0xnull9',
      feedbackIndex: '10',
      reason: 'revoked',
    });
  });

  it('separates the two verified counts', () => {
    const manifest = manifestFor([
      ...SET.slice(0, 4),
      review(60, 4, { reviewType: 1, paymentAmount: 10_000_000n }),
    ]);
    expect(manifest.humanVerifiedCount).toBe(4);
    expect(manifest.receiptVerifiedCount).toBe(1);
  });
});

describe('manifestHash', () => {
  it('is keccak256 of the canonical serialisation', () => {
    const manifest = manifestFor(SET);
    expect(manifestHash(manifest)).toBe(keccak256(toBytes(canonicalJson(manifest))));
  });

  it('is stable across runs for the same inputs', () => {
    expect(manifestHash(manifestFor(SET))).toBe(manifestHash(manifestFor(SET)));
  });

  it('is stable when the reviews arrive in a different order', () => {
    const shuffled = [SET[2], SET[0], SET[4], SET[1], SET[3]].filter(
      (r): r is ReviewInput => r !== undefined,
    );
    expect(manifestHash(manifestFor(shuffled))).toBe(manifestHash(manifestFor(SET)));
  });

  it('changes when a single rating changes', () => {
    const altered = SET.map((r, i) => (i === 2 ? { ...r, value: 31n } : r));
    expect(manifestHash(manifestFor(altered))).not.toBe(manifestHash(manifestFor(SET)));
  });

  it('changes when the snapshot block changes, so a score is pinned in time', () => {
    const a = buildManifest({
      agentId: 1n,
      chainId: 11155111,
      snapshotBlock: 100n,
      contracts: CONTRACTS,
      result: computeReputation(SET),
    });
    const b = buildManifest({
      agentId: 1n,
      chainId: 11155111,
      snapshotBlock: 101n,
      contracts: CONTRACTS,
      result: computeReputation(SET),
    });
    expect(manifestHash(a)).not.toBe(manifestHash(b));
  });
});

describe('revocation-aware recomputation', () => {
  it('recomputes a different score once an entry is revoked', () => {
    const before = computeReputation([...SET, review(90, 5), review(95, 6)]);
    expect(before.score).toBe(40n);

    // The registry later reports the two high entries revoked.
    const after = computeReputation([
      ...SET,
      review(90, 5, { revoked: true }),
      review(95, 6, { revoked: true }),
    ]);
    expect(after.score).toBe(30n);
    expect(after.excluded.filter((e) => e.reason === 'revoked')).toHaveLength(2);
  });

  it('withdraws the score entirely if revocation drops it below threshold', () => {
    const after = computeReputation(SET.map((r, i) => (i === 0 ? { ...r, revoked: true } : r)));
    expect(after.status).toBe('below_threshold');
    expect(after.score).toBeNull();
  });

  it('produces a different evidence hash before and after revocation', () => {
    const before = manifestFor([...SET, review(90, 5)]);
    const after = manifestFor([...SET, review(90, 5, { revoked: true })]);
    expect(manifestHash(before)).not.toBe(manifestHash(after));
  });
});

import { describe, expect, it } from 'vitest';
import { hashTypedData, keccak256, toBytes } from 'viem';
import type { Hex } from 'viem';
import {
  ATTESTATION_TYPES,
  ATTESTATION_TYPE_STRING,
  AttestationValidationError,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  PRIMARY_TYPE,
  REVIEW_TYPE,
  ZERO_BYTES32,
  attestationDomain,
  validateAttestation,
} from '../src/signing/attestation.js';
import type { Attestation } from '../src/signing/attestation.js';
import { FREE_ATTESTATION, VECTOR, paidAttestation } from './vectors.js';

/** Issue fields reported for `att`, or [] if it validates. */
function issueFields(att: Attestation): string[] {
  try {
    validateAttestation(att);
    return [];
  } catch (err) {
    if (err instanceof AttestationValidationError) return err.issues.map((i) => i.field);
    throw err;
  }
}

describe('EIP-712 schema', () => {
  it('matches the contract type string field-for-field', () => {
    const fields = ATTESTATION_TYPES.Attestation.map((f) => `${f.type} ${f.name}`).join(',');
    expect(`${PRIMARY_TYPE}(${fields})`).toBe(ATTESTATION_TYPE_STRING);
  });

  it('hashes the type string to the contract typehash', () => {
    // Reference computed with `cast keccak "<type string>"`.
    expect(keccak256(toBytes(ATTESTATION_TYPE_STRING))).toBe(VECTOR.attestationTypehash);
  });

  it('uses the contract domain name and version', () => {
    expect(DOMAIN_NAME).toBe('ReceiptsReviewGateway');
    expect(DOMAIN_VERSION).toBe('1');
  });
});

describe('attestationDomain', () => {
  it('binds the configured chain id and gateway address', () => {
    const domain = attestationDomain(VECTOR.chainId, VECTOR.gateway);

    expect(domain).toEqual({
      name: 'ReceiptsReviewGateway',
      version: '1',
      chainId: VECTOR.chainId,
      verifyingContract: VECTOR.gateway,
    });
  });

  it('returns a frozen domain', () => {
    const domain = attestationDomain(VECTOR.chainId, VECTOR.gateway);

    expect(Object.isFrozen(domain)).toBe(true);
    expect(() => {
      (domain as { chainId?: number }).chainId = 1;
    }).toThrow(TypeError);
    expect(domain.chainId).toBe(VECTOR.chainId);
  });

  it('returns an independent object per call', () => {
    const a = attestationDomain(VECTOR.chainId, VECTOR.gateway);
    const b = attestationDomain(1, VECTOR.gateway);

    expect(a.chainId).toBe(VECTOR.chainId);
    expect(b.chainId).toBe(1);
  });
});

describe('schema immutability', () => {
  it('freezes the types object, the field array, and every field', () => {
    expect(Object.isFrozen(ATTESTATION_TYPES)).toBe(true);
    expect(Object.isFrozen(ATTESTATION_TYPES.Attestation)).toBe(true);

    for (const field of ATTESTATION_TYPES.Attestation) {
      expect(Object.isFrozen(field)).toBe(true);
    }
  });

  it('rejects renaming a field at runtime', () => {
    const digestBefore = hashTypedData({
      domain: attestationDomain(VECTOR.chainId, VECTOR.gateway),
      types: ATTESTATION_TYPES,
      primaryType: PRIMARY_TYPE,
      message: FREE_ATTESTATION,
    });

    expect(() => {
      (ATTESTATION_TYPES.Attestation[0] as { name?: string }).name = 'tampered';
    }).toThrow(TypeError);

    expect(ATTESTATION_TYPES.Attestation[0]?.name).toBe('agentId');
    expect(
      hashTypedData({
        domain: attestationDomain(VECTOR.chainId, VECTOR.gateway),
        types: ATTESTATION_TYPES,
        primaryType: PRIMARY_TYPE,
        message: FREE_ATTESTATION,
      }),
    ).toBe(digestBefore);
  });

  it('rejects replacing or reordering the field array', () => {
    expect(() => {
      (ATTESTATION_TYPES as { Attestation?: unknown }).Attestation = [];
    }).toThrow(TypeError);

    expect(() => {
      (ATTESTATION_TYPES.Attestation as unknown as { push: (v: unknown) => number }).push({
        name: 'extra',
        type: 'uint256',
      });
    }).toThrow(TypeError);

    expect(() => {
      (ATTESTATION_TYPES.Attestation as unknown as { reverse: () => unknown }).reverse();
    }).toThrow(TypeError);

    expect(ATTESTATION_TYPES.Attestation).toHaveLength(10);
    expect(ATTESTATION_TYPES.Attestation[0]?.name).toBe('agentId');
    expect(ATTESTATION_TYPES.Attestation[7]?.name).toBe('feedbackURI');
    expect(ATTESTATION_TYPES.Attestation[9]?.name).toBe('receiptId');
  });

  it('keeps the typehash stable after mutation attempts', () => {
    const fields = ATTESTATION_TYPES.Attestation.map((f) => `${f.type} ${f.name}`).join(',');

    expect(keccak256(toBytes(`${PRIMARY_TYPE}(${fields})`))).toBe(VECTOR.attestationTypehash);
  });
});

describe('digest', () => {
  /** Hash a raw message against the real domain and types, skipping validation. */
  const rawHash = (message: Record<string, unknown>): Hex =>
    hashTypedData({
      domain: attestationDomain(VECTOR.chainId, VECTOR.gateway),
      types: ATTESTATION_TYPES,
      primaryType: PRIMARY_TYPE,
      message: message as never,
    });

  it('matches the digest computed from the Solidity encoding', () => {
    // Reference produced with cast, replicating ReviewGateway._digest:
    // keccak256(0x1901 ++ domainSeparator ++ structHash).
    expect(rawHash({ ...FREE_ATTESTATION })).toBe(VECTOR.digest);
  });

  describe('binds every signed field', () => {
    // One mutation per field. These bypass validateAttestation on purpose: the
    // question here is whether the field is part of the signed message, which
    // is a property of the encoding, independent of the gateway's value rules.
    const mutations: ReadonlyArray<readonly [string, Partial<Record<string, unknown>>]> = [
      ['agentId', { agentId: FREE_ATTESTATION.agentId + 1n }],
      ['nullifier', { nullifier: `0x${'12'.repeat(32)}` }],
      ['reviewer', { reviewer: `0x${'99'.repeat(20)}` }],
      ['expiry', { expiry: FREE_ATTESTATION.expiry + 1n }],
      ['value', { value: FREE_ATTESTATION.value + 1n }],
      ['valueDecimals', { valueDecimals: 1 }],
      ['feedbackHash', { feedbackHash: `0x${'45'.repeat(32)}` }],
      ['feedbackURI', { feedbackURI: 'https://receipts.test/reviews/0xsomewhere-else' }],
      ['reviewType', { reviewType: REVIEW_TYPE.PAID }],
      ['receiptId', { receiptId: `0x${'77'.repeat(32)}` }],
    ];

    const baseline = rawHash({ ...FREE_ATTESTATION });

    it.each(mutations)('changes the digest when %s changes', (_field, mutation) => {
      expect(rawHash({ ...FREE_ATTESTATION, ...mutation })).not.toBe(baseline);
    });

    it('covers all ten fields', () => {
      expect(mutations.map(([f]) => f)).toEqual(ATTESTATION_TYPES.Attestation.map((f) => f.name));
    });
  });

  it('changes with the chain id', () => {
    const other = hashTypedData({
      domain: attestationDomain(VECTOR.chainId + 1, VECTOR.gateway),
      types: ATTESTATION_TYPES,
      primaryType: PRIMARY_TYPE,
      message: { ...FREE_ATTESTATION },
    });

    expect(other).not.toBe(VECTOR.digest);
  });

  it('changes with the gateway address', () => {
    const other = hashTypedData({
      domain: attestationDomain(VECTOR.chainId, `0x${'ee'.repeat(20)}`),
      types: ATTESTATION_TYPES,
      primaryType: PRIMARY_TYPE,
      message: { ...FREE_ATTESTATION },
    });

    expect(other).not.toBe(VECTOR.digest);
  });
});

describe('validateAttestation', () => {
  it('accepts a free attestation', () => {
    expect(validateAttestation(FREE_ATTESTATION)).toEqual(FREE_ATTESTATION);
  });

  it('accepts a paid attestation', () => {
    const paid = paidAttestation();
    expect(validateAttestation(paid)).toEqual(paid);
  });

  it('normalizes hex case without changing the digest', () => {
    const upper: Attestation = {
      ...FREE_ATTESTATION,
      nullifier: FREE_ATTESTATION.nullifier.toUpperCase().replace('0X', '0x') as Hex,
      feedbackHash: FREE_ATTESTATION.feedbackHash.toUpperCase().replace('0X', '0x') as Hex,
    };

    const normalized = validateAttestation(upper);

    expect(normalized.nullifier).toBe(FREE_ATTESTATION.nullifier);
    expect(normalized.feedbackHash).toBe(FREE_ATTESTATION.feedbackHash);
  });

  it('returns a checksummed reviewer address', () => {
    const lower = `0x${'ab'.repeat(20)}` as const;
    const normalized = validateAttestation({ ...FREE_ATTESTATION, reviewer: lower });

    expect(normalized.reviewer.toLowerCase()).toBe(lower);
    expect(normalized.reviewer).not.toBe(lower);
  });

  describe('bytes32 fields', () => {
    it.each(['nullifier', 'feedbackHash', 'receiptId'] as const)(
      'rejects a malformed %s',
      (field) => {
        for (const bad of [
          '0x',
          '0x1234',
          `0x${'11'.repeat(31)}`,
          `0x${'11'.repeat(33)}`,
          `${'11'.repeat(32)}`,
        ]) {
          expect(issueFields({ ...FREE_ATTESTATION, [field]: bad })).toContain(field);
        }
      },
    );

    it('rejects a zero nullifier', () => {
      expect(issueFields({ ...FREE_ATTESTATION, nullifier: ZERO_BYTES32 })).toEqual(['nullifier']);
    });

    it('allows a zero feedbackHash', () => {
      expect(issueFields({ ...FREE_ATTESTATION, feedbackHash: ZERO_BYTES32 })).toEqual([]);
    });
  });

  describe('reviewer', () => {
    it.each(['0x', '0x123', 'not-an-address', `0x${'22'.repeat(21)}`])('rejects %o', (bad) => {
      expect(issueFields({ ...FREE_ATTESTATION, reviewer: bad as Hex })).toContain('reviewer');
    });

    it('rejects the zero address', () => {
      expect(issueFields({ ...FREE_ATTESTATION, reviewer: `0x${'00'.repeat(20)}` })).toEqual([
        'reviewer',
      ]);
    });
  });

  describe('integer ranges', () => {
    it('rejects a negative agentId', () => {
      expect(issueFields({ ...FREE_ATTESTATION, agentId: -1n })).toEqual(['agentId']);
    });

    it('rejects an agentId above uint256', () => {
      expect(issueFields({ ...FREE_ATTESTATION, agentId: 2n ** 256n })).toEqual(['agentId']);
    });

    it('accepts the uint256 maximum agentId', () => {
      expect(issueFields({ ...FREE_ATTESTATION, agentId: 2n ** 256n - 1n })).toEqual([]);
    });

    it('rejects an expiry above uint64', () => {
      expect(issueFields({ ...FREE_ATTESTATION, expiry: 2n ** 64n })).toEqual(['expiry']);
    });

    it('accepts the uint64 maximum expiry', () => {
      expect(issueFields({ ...FREE_ATTESTATION, expiry: 2n ** 64n - 1n })).toEqual([]);
    });

    it.each([-1n, 101n, 1000n])('rejects a value of %o', (value) => {
      expect(issueFields({ ...FREE_ATTESTATION, value })).toEqual(['value']);
    });

    it.each([0n, 1n, 50n, 100n])('accepts a value of %o', (value) => {
      expect(issueFields({ ...FREE_ATTESTATION, value })).toEqual([]);
    });

    it.each([1, 2, 18, -1])('rejects valueDecimals of %o', (valueDecimals) => {
      expect(issueFields({ ...FREE_ATTESTATION, valueDecimals })).toEqual(['valueDecimals']);
    });

    it('rejects a non-bigint agentId', () => {
      expect(issueFields({ ...FREE_ATTESTATION, agentId: 42 as unknown as bigint })).toEqual([
        'agentId',
      ]);
    });

    it('rejects a non-bigint value', () => {
      expect(issueFields({ ...FREE_ATTESTATION, value: 80 as unknown as bigint })).toEqual([
        'value',
      ]);
    });
  });

  describe('review type and receipt pairing', () => {
    it.each([3, 255, -1])('rejects a reviewType of %o', (reviewType) => {
      expect(issueFields({ ...FREE_ATTESTATION, reviewType })).toContain('reviewType');
    });

    it("rejects a wallet reviewType unless it carries the reviewer's wallet nullifier", () => {
      // A World ID nullifier on a wallet review would let the review claim a
      // personhood-backed identity it does not have.
      expect(issueFields({ ...FREE_ATTESTATION, reviewType: 2 })).toContain('nullifier');
    });

    it('rejects a free review carrying a receiptId', () => {
      expect(issueFields({ ...FREE_ATTESTATION, receiptId: `0x${'77'.repeat(32)}` })).toEqual([
        'receiptId',
      ]);
    });

    it('rejects a paid review with a zero receiptId', () => {
      expect(issueFields({ ...paidAttestation(), receiptId: ZERO_BYTES32 })).toEqual(['receiptId']);
    });
  });

  it('reports every bad field in one pass', () => {
    const fields = issueFields({
      ...FREE_ATTESTATION,
      agentId: -1n,
      nullifier: ZERO_BYTES32,
      reviewer: '0xdead' as Hex,
      value: 500n,
      valueDecimals: 3,
      reviewType: 9,
    });

    expect(fields).toEqual(
      expect.arrayContaining([
        'agentId',
        'nullifier',
        'reviewer',
        'value',
        'valueDecimals',
        'reviewType',
      ]),
    );
  });
});

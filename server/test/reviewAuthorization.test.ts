import { describe, expect, it } from 'vitest';
import { getAddress, hashTypedData, isAddress, keccak256, toBytes } from 'viem';
import type { Address, Hex } from 'viem';
import {
  AUTHORIZATION_DOMAIN_NAME,
  AUTHORIZATION_PRIMARY_TYPE,
  AUTHORIZATION_TYPES,
  AUTHORIZATION_TYPE_STRING,
  AuthorizationValidationError,
  InvalidAuthorizationDomainError,
  authorizationDigest,
  authorizationDomain,
  authorizationTypedData,
  validateReviewAuthorization,
} from '../src/signing/reviewAuthorization.js';
import type { ReviewAuthorization } from '../src/signing/reviewAuthorization.js';
import {
  InvalidNullifierError,
  REVIEW_TYPE,
  ZERO_BYTES32,
  nullifierToBytes32,
} from '../src/signing/reviewContent.js';
import { AUTH_VECTOR, authorization } from './authorizationFixtures.js';

describe('nullifierToBytes32', () => {
  it('converts a decimal field element to left-padded bytes32', () => {
    expect(nullifierToBytes32('7')).toBe(`0x${'00'.repeat(31)}07`);
  });

  it('round-trips through BigInt', () => {
    const decimal = '123456789012345678901234567890';
    expect(BigInt(nullifierToBytes32(decimal)).toString(10)).toBe(decimal);
  });

  it('converts the uint256 maximum', () => {
    const max = (2n ** 256n - 1n).toString(10);
    expect(nullifierToBytes32(max)).toBe(`0x${'ff'.repeat(32)}`);
  });

  it.each(['', ' ', '0x07', 'abc', '1.5', '-1', '1e3'])('rejects the non-decimal %o', (value) => {
    expect(() => nullifierToBytes32(value)).toThrow(InvalidNullifierError);
  });

  it('rejects zero', () => {
    expect(() => nullifierToBytes32('0')).toThrow(/must not be zero/);
  });

  it('rejects a value above uint256', () => {
    expect(() => nullifierToBytes32((2n ** 256n).toString(10))).toThrow(/uint256/);
  });

  it('rejects an absurdly long digit string without parsing it', () => {
    expect(() => nullifierToBytes32('9'.repeat(100_000))).toThrow(/uint256/);
  });

  it('always produces exactly 32 bytes', () => {
    for (const d of ['1', '255', '65536', (2n ** 255n).toString(10)]) {
      expect(nullifierToBytes32(d)).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});

describe('EIP-712 schema', () => {
  it('matches the declared type string field-for-field', () => {
    const fields = AUTHORIZATION_TYPES.ReviewAuthorization.map((f) => `${f.type} ${f.name}`).join(
      ',',
    );
    expect(`${AUTHORIZATION_PRIMARY_TYPE}(${fields})`).toBe(AUTHORIZATION_TYPE_STRING);
  });

  it('hashes the type string to the reference typehash', () => {
    // Reference computed with `cast keccak "<type string>"`.
    expect(keccak256(toBytes(AUTHORIZATION_TYPE_STRING))).toBe(AUTH_VECTOR.typehash);
  });

  it('uses the gateway field types for every shared field', () => {
    // The wallet must sign the same encoding the gateway will check.
    const types = Object.fromEntries(
      AUTHORIZATION_TYPES.ReviewAuthorization.map((f) => [f.name, f.type]),
    );

    expect(types).toMatchObject({
      agentId: 'uint256',
      nullifier: 'bytes32',
      reviewer: 'address',
      value: 'int128',
      valueDecimals: 'uint8',
      feedbackHash: 'bytes32',
      reviewType: 'uint8',
      receiptId: 'bytes32',
    });
  });

  it('does not sign an on-chain expiry', () => {
    // The human authorizes content; the server picks the validity window.
    const names = AUTHORIZATION_TYPES.ReviewAuthorization.map((f) => f.name);
    expect(names).not.toContain('expiry');
    expect(names).toContain('nonce');
    expect(names).toContain('deadline');
  });

  it('uses a domain name distinct from the gateway attestation', () => {
    expect(AUTHORIZATION_DOMAIN_NAME).toBe('ReceiptsReviewAuthorization');
    expect(AUTHORIZATION_DOMAIN_NAME).not.toBe('ReceiptsReviewGateway');
  });

  it('freezes the schema against runtime mutation', () => {
    expect(Object.isFrozen(AUTHORIZATION_TYPES)).toBe(true);
    expect(Object.isFrozen(AUTHORIZATION_TYPES.ReviewAuthorization)).toBe(true);
    for (const field of AUTHORIZATION_TYPES.ReviewAuthorization) {
      expect(Object.isFrozen(field)).toBe(true);
    }
    expect(() => {
      (AUTHORIZATION_TYPES.ReviewAuthorization[0] as { name?: string }).name = 'tampered';
    }).toThrow(TypeError);
  });
});

describe('authorizationDomain', () => {
  it('binds the real chain id and gateway address', () => {
    expect(authorizationDomain(AUTH_VECTOR.chainId, AUTH_VECTOR.gateway)).toEqual({
      name: 'ReceiptsReviewAuthorization',
      version: '1',
      chainId: AUTH_VECTOR.chainId,
      verifyingContract: AUTH_VECTOR.gateway,
    });
  });

  it('is frozen', () => {
    const domain = authorizationDomain(AUTH_VECTOR.chainId, AUTH_VECTOR.gateway);

    expect(Object.isFrozen(domain)).toBe(true);
    expect(() => {
      (domain as { chainId?: number }).chainId = 1;
    }).toThrow(TypeError);
  });

  describe('input validation', () => {
    it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
      'rejects the chain id %o',
      (chainId) => {
        expect(() => authorizationDomain(chainId, AUTH_VECTOR.gateway)).toThrow(
          InvalidAuthorizationDomainError,
        );
      },
    );

    it('rejects the zero verifying contract', () => {
      expect(() => authorizationDomain(AUTH_VECTOR.chainId, `0x${'00'.repeat(20)}`)).toThrow(
        /must not be the zero address/,
      );
    });

    it.each(['', '0xdead', 'not-an-address', `0x${'22'.repeat(21)}`])(
      'rejects the verifying contract %o',
      (address) => {
        expect(() => authorizationDomain(AUTH_VECTOR.chainId, address as Address)).toThrow(
          InvalidAuthorizationDomainError,
        );
      },
    );

    it('accepts a valid chain id and gateway', () => {
      expect(() => authorizationDomain(1, AUTH_VECTOR.gateway)).not.toThrow();
    });

    it('normalizes a lowercase gateway address', () => {
      const domain = authorizationDomain(
        AUTH_VECTOR.chainId,
        AUTH_VECTOR.gateway.toLowerCase() as Address,
      );

      expect(domain.verifyingContract).toBe(AUTH_VECTOR.gateway);
    });

    it('normalizes an incorrectly checksummed mixed-case address', () => {
      // viem's getAddress re-checksums rather than rejecting a bad checksum.
      // Casing cannot reach an EIP-712 digest — an address is encoded as 20
      // bytes — so the domain must carry the canonical form whatever was passed.
      const correct = getAddress(`0x${'ab'.repeat(20)}`);
      const lastIsUpper = correct.slice(-1) === correct.slice(-1).toUpperCase();
      const miscased =
        correct.slice(0, -1) +
        (lastIsUpper ? correct.slice(-1).toLowerCase() : correct.slice(-1).toUpperCase());

      expect(miscased).not.toBe(correct);
      expect(isAddress(miscased, { strict: true })).toBe(false);

      const domain = authorizationDomain(AUTH_VECTOR.chainId, miscased as Address);
      expect(domain.verifyingContract).toBe(correct);
    });

    it('produces the same digest whatever casing the gateway was given', () => {
      const lower = authorizationDigest(
        authorization(),
        AUTH_VECTOR.chainId,
        AUTH_VECTOR.gateway.toLowerCase() as Address,
      );

      expect(lower).toBe(AUTH_VECTOR.digest);
    });

    it('rejects through the digest helper too', () => {
      expect(() => authorizationDigest(authorization(), 0, AUTH_VECTOR.gateway)).toThrow(
        InvalidAuthorizationDomainError,
      );
    });
  });
});

describe('authorizationDigest', () => {
  const digest = (auth = authorization()) =>
    authorizationDigest(auth, AUTH_VECTOR.chainId, AUTH_VECTOR.gateway);

  it('matches the digest computed from the Solidity encoding', () => {
    // Reference produced with cast: keccak256(0x1901 ++ domainSeparator ++ structHash).
    expect(digest()).toBe(AUTH_VECTOR.digest);
  });

  describe('binds every signed field', () => {
    const mutations: ReadonlyArray<readonly [string, Partial<ReviewAuthorization>]> = [
      ['agentId', { agentId: 43n }],
      ['nullifier', { nullifier: `0x${'00'.repeat(31)}08` }],
      ['reviewer', { reviewer: `0x${'99'.repeat(20)}` }],
      ['value', { value: 81n }],
      ['feedbackHash', { feedbackHash: `0x${'45'.repeat(32)}` }],
      ['nonce', { nonce: `0x${'66'.repeat(32)}` }],
      ['deadline', { deadline: 1_800_000_001n }],
    ];

    it.each(mutations)('changes the digest when %s changes', (_field, mutation) => {
      expect(digest(authorization(mutation))).not.toBe(AUTH_VECTOR.digest);
    });

    it('changes the digest for the paid path', () => {
      // reviewType and receiptId move together to stay valid.
      const paid = authorization({
        reviewType: REVIEW_TYPE.PAID,
        receiptId: `0x${'77'.repeat(32)}`,
      });

      expect(digest(paid)).not.toBe(AUTH_VECTOR.digest);
    });

    it('changes the digest when valueDecimals changes', () => {
      // `validateReviewAuthorization` requires 0, so the digest is taken from
      // the raw typed data — the question here is whether the field is signed.
      const withDecimals = hashTypedData({
        domain: authorizationDomain(AUTH_VECTOR.chainId, AUTH_VECTOR.gateway),
        types: AUTHORIZATION_TYPES,
        primaryType: AUTHORIZATION_PRIMARY_TYPE,
        message: { ...authorization(), valueDecimals: 1 },
      });

      expect(withDecimals).not.toBe(AUTH_VECTOR.digest);
    });

    it('changes the digest when reviewType changes, holding receiptId', () => {
      // A valid paid pairing differs from the free baseline on two fields, so
      // these two tests isolate each one against a shared paid reference.
      const paidReceipt = `0x${'77'.repeat(32)}` as Hex;
      const paid = digest(authorization({ reviewType: REVIEW_TYPE.PAID, receiptId: paidReceipt }));
      const freeWithSameReceipt = hashTypedData({
        domain: authorizationDomain(AUTH_VECTOR.chainId, AUTH_VECTOR.gateway),
        types: AUTHORIZATION_TYPES,
        primaryType: AUTHORIZATION_PRIMARY_TYPE,
        message: { ...authorization(), reviewType: REVIEW_TYPE.FREE, receiptId: paidReceipt },
      });

      // Same receiptId, only reviewType differs.
      expect(freeWithSameReceipt).not.toBe(paid);
    });

    it('changes the digest when receiptId changes, holding reviewType', () => {
      const paid = (receiptId: Hex) =>
        digest(authorization({ reviewType: REVIEW_TYPE.PAID, receiptId }));

      // Same reviewType, only receiptId differs.
      expect(paid(`0x${'77'.repeat(32)}`)).not.toBe(paid(`0x${'88'.repeat(32)}`));
    });

    it('covers all ten fields', () => {
      const covered = [...mutations.map(([f]) => f), 'valueDecimals', 'reviewType', 'receiptId'];
      expect(covered.sort()).toEqual(
        AUTHORIZATION_TYPES.ReviewAuthorization.map((f) => f.name).sort(),
      );
    });
  });

  it('changes with the chain id', () => {
    expect(authorizationDigest(authorization(), 1, AUTH_VECTOR.gateway)).not.toBe(
      AUTH_VECTOR.digest,
    );
  });

  it('changes with the gateway address', () => {
    expect(
      authorizationDigest(authorization(), AUTH_VECTOR.chainId, `0x${'ee'.repeat(20)}`),
    ).not.toBe(AUTH_VECTOR.digest);
  });

  it('differs from an attestation digest over the same values', () => {
    // Different domain and different primary type: no cross-type confusion.
    const asAttestation = hashTypedData({
      domain: {
        name: 'ReceiptsReviewGateway',
        version: '1',
        chainId: AUTH_VECTOR.chainId,
        verifyingContract: AUTH_VECTOR.gateway,
      },
      types: AUTHORIZATION_TYPES,
      primaryType: AUTHORIZATION_PRIMARY_TYPE,
      message: authorization(),
    });

    expect(asAttestation).not.toBe(AUTH_VECTOR.digest);
  });
});

describe('validateReviewAuthorization', () => {
  it('accepts a well-formed free authorization', () => {
    expect(validateReviewAuthorization(authorization())).toEqual(authorization());
  });

  it('accepts a paid authorization', () => {
    const paid = authorization({
      reviewType: REVIEW_TYPE.PAID,
      receiptId: `0x${'77'.repeat(32)}`,
    });

    expect(validateReviewAuthorization(paid)).toEqual(paid);
  });

  it('applies the same review rules as the attestation', () => {
    // Shared validator: the human can never be asked to authorize content the
    // gateway would reject.
    for (const bad of [
      { value: 101n },
      { value: -1n },
      { valueDecimals: 1 },
      { reviewType: 3 },
      { reviewType: 2 }, // wallet type without the wallet nullifier
      { nullifier: ZERO_BYTES32 },
      { reviewer: `0x${'00'.repeat(20)}` as Hex },
      { receiptId: `0x${'77'.repeat(32)}` as Hex }, // free review with a receipt
    ]) {
      expect(() => validateReviewAuthorization(authorization(bad))).toThrow(
        AuthorizationValidationError,
      );
    }
  });

  it('rejects a paid authorization with a zero receiptId', () => {
    expect(() =>
      validateReviewAuthorization(authorization({ reviewType: REVIEW_TYPE.PAID })),
    ).toThrow(/receiptId/);
  });

  it.each(['', '0xabc', `0x${'66'.repeat(31)}`, '66'.repeat(32)])(
    'rejects the malformed nonce %o',
    (nonce) => {
      expect(() => validateReviewAuthorization(authorization({ nonce: nonce as Hex }))).toThrow(
        /nonce/,
      );
    },
  );

  it('rejects a deadline above uint64', () => {
    expect(() => validateReviewAuthorization(authorization({ deadline: 2n ** 64n }))).toThrow(
      /deadline/,
    );
  });

  it('does not judge whether the deadline has passed', () => {
    // Freshness belongs to the consuming endpoint, which has a clock.
    expect(() => validateReviewAuthorization(authorization({ deadline: 1n }))).not.toThrow();
  });

  it('reports every bad field at once', () => {
    let issues: readonly { field: string }[] = [];
    try {
      validateReviewAuthorization(authorization({ value: 500n, valueDecimals: 3, nonce: '0x1' }));
    } catch (err) {
      issues = (err as AuthorizationValidationError).issues;
    }

    expect(issues.map((i) => i.field)).toEqual(
      expect.arrayContaining(['value', 'valueDecimals', 'nonce']),
    );
  });

  it('canonicalizes hex case without changing the digest', () => {
    const upper = authorization({
      feedbackHash: `0x${'44'.repeat(32)}`.toUpperCase().replace('0X', '0x') as Hex,
    });

    expect(authorizationDigest(upper, AUTH_VECTOR.chainId, AUTH_VECTOR.gateway)).toBe(
      AUTH_VECTOR.digest,
    );
  });
});

describe('authorizationTypedData', () => {
  it('returns data a wallet can sign directly', () => {
    const data = authorizationTypedData(authorization(), AUTH_VECTOR.chainId, AUTH_VECTOR.gateway);

    expect(data.primaryType).toBe('ReviewAuthorization');
    expect(data.types).toBe(AUTHORIZATION_TYPES);
    expect(hashTypedData(data)).toBe(AUTH_VECTOR.digest);
  });

  it('validates before building', () => {
    expect(() =>
      authorizationTypedData(
        authorization({ value: 500n }),
        AUTH_VECTOR.chainId,
        AUTH_VECTOR.gateway,
      ),
    ).toThrow(AuthorizationValidationError);
  });
});

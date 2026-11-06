import { describe, expect, it } from 'vitest';
import { privateKeyToAddress } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import type { Hex } from 'viem';
import {
  ATTESTATION_TYPES,
  AttestationValidationError,
  PRIMARY_TYPE,
  REVIEW_TYPE,
  ZERO_BYTES32,
  attestationDomain,
} from '../src/signing/attestation.js';
import type { Attestation } from '../src/signing/attestation.js';
import {
  InvalidPrivateKeyError,
  SignatureIntegrityError,
  createAttestationSigner,
  createAttestationSignerFromEnv,
} from '../src/signing/signer.js';
import { loadEnv } from '../src/config/env.js';
import { FREE_ATTESTATION, TEST_PRIVATE_KEY, VECTOR, paidAttestation } from './vectors.js';
import { envWith } from './fixtures.js';

const signer = () =>
  createAttestationSigner({
    privateKey: TEST_PRIVATE_KEY,
    chainId: VECTOR.chainId,
    reviewGatewayAddress: VECTOR.gateway,
  });

describe('createAttestationSigner', () => {
  it('derives the account address from the private key', () => {
    expect(signer().address).toBe(privateKeyToAddress(TEST_PRIVATE_KEY));
  });

  it('exposes the configured domain', () => {
    expect(signer().domain).toEqual(attestationDomain(VECTOR.chainId, VECTOR.gateway));
  });

  it('binds a different chain id into the domain', () => {
    const other = createAttestationSigner({
      privateKey: TEST_PRIVATE_KEY,
      chainId: 1,
      reviewGatewayAddress: VECTOR.gateway,
    });

    expect(other.domain.chainId).toBe(1);
    expect(other.hash(FREE_ATTESTATION)).not.toBe(signer().hash(FREE_ATTESTATION));
  });

  it('binds a different gateway address into the domain', () => {
    const other = createAttestationSigner({
      privateKey: TEST_PRIVATE_KEY,
      chainId: VECTOR.chainId,
      reviewGatewayAddress: `0x${'ee'.repeat(20)}`,
    });

    expect(other.hash(FREE_ATTESTATION)).not.toBe(signer().hash(FREE_ATTESTATION));
  });

  describe('invalid private keys', () => {
    it.each([
      ['too short', '0x1234'],
      ['missing 0x', '11'.repeat(32)],
      ['not hex', `0x${'zz'.repeat(32)}`],
      ['too long', `0x${'11'.repeat(33)}`],
      ['empty', ''],
    ])('rejects a key that is %s', (_label, key) => {
      expect(() =>
        createAttestationSigner({
          privateKey: key as Hex,
          chainId: VECTOR.chainId,
          reviewGatewayAddress: VECTOR.gateway,
        }),
      ).toThrow(InvalidPrivateKeyError);
    });

    it.each([
      ['zero', `0x${'00'.repeat(32)}`],
      // Above the secp256k1 group order.
      ['out of range', `0x${'ff'.repeat(32)}`],
    ])('rejects a key that is %s', (_label, key) => {
      expect(() =>
        createAttestationSigner({
          privateKey: key as Hex,
          chainId: VECTOR.chainId,
          reviewGatewayAddress: VECTOR.gateway,
        }),
      ).toThrow(InvalidPrivateKeyError);
    });
  });
});

describe('hash', () => {
  it('matches the Solidity-derived reference digest', () => {
    expect(signer().hash(FREE_ATTESTATION)).toBe(VECTOR.digest);
  });

  it('validates before hashing', () => {
    expect(() => signer().hash({ ...FREE_ATTESTATION, value: 500n })).toThrow(
      AttestationValidationError,
    );
  });
});

describe('sign', () => {
  it('produces a 65-byte signature with canonical v', async () => {
    const signature = await signer().sign(FREE_ATTESTATION);

    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    const v = Number.parseInt(signature.slice(130, 132), 16);
    expect([27, 28]).toContain(v);
  });

  it('produces a low-s signature, as the gateway requires', async () => {
    const signature = await signer().sign(FREE_ATTESTATION);
    const s = BigInt(`0x${signature.slice(66, 130)}`);

    expect(s).toBeLessThanOrEqual(
      0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n,
    );
  });

  it('recovers to the signing address', async () => {
    const s = signer();
    const signature = await s.sign(FREE_ATTESTATION);

    expect(await s.recover(FREE_ATTESTATION, signature)).toBe(s.address);
    expect(await s.verify(FREE_ATTESTATION, signature)).toBe(true);
  });

  it('recovers to the signing address under viem directly', async () => {
    const s = signer();
    const signature = await s.sign(FREE_ATTESTATION);

    const recovered = await recoverTypedDataAddress({
      domain: attestationDomain(VECTOR.chainId, VECTOR.gateway),
      types: ATTESTATION_TYPES,
      primaryType: PRIMARY_TYPE,
      message: FREE_ATTESTATION,
      signature,
    });

    expect(recovered).toBe(s.address);
  });

  it('signs a paid attestation', async () => {
    const s = signer();
    const paid = paidAttestation();

    expect(await s.verify(paid, await s.sign(paid))).toBe(true);
  });

  it('is deterministic for the same attestation', async () => {
    const s = signer();

    expect(await s.sign(FREE_ATTESTATION)).toBe(await s.sign(FREE_ATTESTATION));
  });

  it('refuses to sign an invalid attestation', async () => {
    await expect(signer().sign({ ...FREE_ATTESTATION, nullifier: ZERO_BYTES32 })).rejects.toThrow(
      AttestationValidationError,
    );
  });
});

describe('tampering', () => {
  /** Mutations that leave the attestation valid, so verification is reached. */
  const mutations: ReadonlyArray<readonly [string, Partial<Attestation>]> = [
    ['agentId', { agentId: 43n }],
    ['nullifier', { nullifier: `0x${'12'.repeat(32)}` }],
    ['reviewer', { reviewer: `0x${'99'.repeat(20)}` }],
    ['expiry', { expiry: 1_800_000_001n }],
    ['value', { value: 81n }],
    ['feedbackHash', { feedbackHash: `0x${'45'.repeat(32)}` }],
  ];

  it.each(mutations)('fails verification when %s is changed', async (_field, mutation) => {
    const s = signer();
    const signature = await s.sign(FREE_ATTESTATION);
    const tampered: Attestation = { ...FREE_ATTESTATION, ...mutation };

    expect(await s.verify(tampered, signature)).toBe(false);
    expect(await s.recover(tampered, signature)).not.toBe(s.address);
  });

  it('fails verification when a free signature is replayed as paid', async () => {
    const s = signer();
    const signature = await s.sign(FREE_ATTESTATION);

    // reviewType and receiptId must move together to stay valid, so this
    // covers the free -> paid path swap rather than either field alone.
    const asPaid = paidAttestation({ value: FREE_ATTESTATION.value });

    expect(await s.verify(asPaid, signature)).toBe(false);
  });

  it('fails verification when a paid signature is replayed as free', async () => {
    const s = signer();
    const paid = paidAttestation();
    const signature = await s.sign(paid);

    const asFree: Attestation = {
      ...paid,
      reviewType: REVIEW_TYPE.FREE,
      receiptId: ZERO_BYTES32,
    };

    expect(await s.verify(asFree, signature)).toBe(false);
  });

  it('fails verification against a different signer', async () => {
    const other = createAttestationSigner({
      privateKey: `0x${'22'.repeat(32)}`,
      chainId: VECTOR.chainId,
      reviewGatewayAddress: VECTOR.gateway,
    });
    const signature = await signer().sign(FREE_ATTESTATION);

    expect(await other.verify(FREE_ATTESTATION, signature)).toBe(false);
  });

  it('fails verification for a different chain id', async () => {
    const signature = await signer().sign(FREE_ATTESTATION);
    const otherChain = createAttestationSigner({
      privateKey: TEST_PRIVATE_KEY,
      chainId: 1,
      reviewGatewayAddress: VECTOR.gateway,
    });

    expect(await otherChain.verify(FREE_ATTESTATION, signature)).toBe(false);
  });

  it('fails verification for a different gateway address', async () => {
    const signature = await signer().sign(FREE_ATTESTATION);
    const otherGateway = createAttestationSigner({
      privateKey: TEST_PRIVATE_KEY,
      chainId: VECTOR.chainId,
      reviewGatewayAddress: `0x${'ee'.repeat(20)}`,
    });

    expect(await otherGateway.verify(FREE_ATTESTATION, signature)).toBe(false);
  });

  it('returns false rather than throwing for a malformed signature', async () => {
    const s = signer();

    expect(await s.verify(FREE_ATTESTATION, '0xdeadbeef')).toBe(false);
  });
});

describe('signature malleability', () => {
  const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const LOW_S_MAX = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

  /**
   * Re-encode a signature as its high-`s` twin: s -> n - s with `v` flipped.
   *
   * Same curve point and same recovered address, but the encoding the gateway's
   * `_recoverStrict` rejects. Derived from a deterministic test signature; no
   * real key is involved.
   */
  function toHighS(signature: Hex): Hex {
    const r = signature.slice(2, 66);
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const v = Number.parseInt(signature.slice(130, 132), 16);

    const highS = (SECP256K1_N - s).toString(16).padStart(64, '0');
    const flippedV = (v === 27 ? 28 : 27).toString(16).padStart(2, '0');

    return `0x${r}${highS}${flippedV}`;
  }

  it('produces a genuinely high-s twin of a low-s signature', async () => {
    const signature = await signer().sign(FREE_ATTESTATION);
    const high = toHighS(signature);

    expect(BigInt(`0x${signature.slice(66, 130)}`)).toBeLessThanOrEqual(LOW_S_MAX);
    expect(BigInt(`0x${high.slice(66, 130)}`)).toBeGreaterThan(LOW_S_MAX);
    expect(high).not.toBe(signature);
    // Same r, so the same curve point in a different encoding.
    expect(high.slice(2, 66)).toBe(signature.slice(2, 66));
  });

  it('is accepted by raw viem, which is why the check is needed', async () => {
    const s = signer();
    const high = toHighS(await s.sign(FREE_ATTESTATION));

    // viem recovers the twin to the same address; the gateway would not accept
    // it. Without assertGatewayCompatible this is exactly the false positive.
    const recovered = await recoverTypedDataAddress({
      domain: attestationDomain(VECTOR.chainId, VECTOR.gateway),
      types: ATTESTATION_TYPES,
      primaryType: PRIMARY_TYPE,
      message: FREE_ATTESTATION,
      signature: high,
    });

    expect(recovered).toBe(s.address);
  });

  it('recover() rejects the high-s twin', async () => {
    const s = signer();
    const high = toHighS(await s.sign(FREE_ATTESTATION));

    await expect(s.recover(FREE_ATTESTATION, high)).rejects.toThrow(SignatureIntegrityError);
    await expect(s.recover(FREE_ATTESTATION, high)).rejects.toThrow(/s is not low/);
  });

  it('verify() returns false for the high-s twin', async () => {
    const s = signer();
    const high = toHighS(await s.sign(FREE_ATTESTATION));

    expect(await s.verify(FREE_ATTESTATION, high)).toBe(false);
  });

  it('still accepts the original low-s signature', async () => {
    const s = signer();
    const signature = await s.sign(FREE_ATTESTATION);

    expect(await s.recover(FREE_ATTESTATION, signature)).toBe(s.address);
    expect(await s.verify(FREE_ATTESTATION, signature)).toBe(true);
  });

  it('recover() rejects a non-canonical v', async () => {
    const signature = await signer().sign(FREE_ATTESTATION);
    const badV = `${signature.slice(0, 130)}1a` as Hex; // v = 26

    await expect(signer().recover(FREE_ATTESTATION, badV)).rejects.toThrow(/v must be 27 or 28/);
    expect(await signer().verify(FREE_ATTESTATION, badV)).toBe(false);
  });

  it('recover() rejects a signature of the wrong length', async () => {
    await expect(signer().recover(FREE_ATTESTATION, '0xdeadbeef')).rejects.toThrow(
      /expected a 65-byte signature/,
    );
  });
});

describe('configuration immutability', () => {
  it('ignores mutation of the exposed domain', () => {
    const s = signer();
    const before = s.hash(FREE_ATTESTATION);

    expect(Object.isFrozen(s.domain)).toBe(true);
    expect(() => {
      (s.domain as { chainId?: number }).chainId = 999;
    }).toThrow(TypeError);

    expect(s.domain.chainId).toBe(VECTOR.chainId);
    expect(s.hash(FREE_ATTESTATION)).toBe(before);
    expect(s.hash(FREE_ATTESTATION)).toBe(VECTOR.digest);
  });

  it('ignores mutation of the exposed verifyingContract', () => {
    const s = signer();

    expect(() => {
      (s.domain as { verifyingContract?: string }).verifyingContract = `0x${'ee'.repeat(20)}`;
    }).toThrow(TypeError);

    expect(s.domain.verifyingContract).toBe(VECTOR.gateway);
    expect(s.hash(FREE_ATTESTATION)).toBe(VECTOR.digest);
  });

  it('ignores mutation of the shared type schema', async () => {
    const s = signer();
    const before = s.hash(FREE_ATTESTATION);
    const signatureBefore = await s.sign(FREE_ATTESTATION);

    const field = ATTESTATION_TYPES.Attestation[0] as { name?: string; type?: string };
    expect(() => {
      field.name = 'tamperedField';
    }).toThrow(TypeError);
    expect(() => {
      field.type = 'uint8';
    }).toThrow(TypeError);

    expect(ATTESTATION_TYPES.Attestation[0]?.name).toBe('agentId');
    expect(s.hash(FREE_ATTESTATION)).toBe(before);
    expect(await s.sign(FREE_ATTESTATION)).toBe(signatureBefore);
  });
});

describe('private key confidentiality', () => {
  const keyBody = TEST_PRIVATE_KEY.slice(2);

  it('keeps the key out of the signer object', async () => {
    const s = signer();
    const signature = await s.sign(FREE_ATTESTATION);

    const surfaces = [
      JSON.stringify(s),
      JSON.stringify(Object.keys(s)),
      String(s.address),
      String(s.hash(FREE_ATTESTATION)),
      signature,
      JSON.stringify(s.domain),
    ];

    for (const surface of surfaces) {
      expect(surface).not.toContain(keyBody);
      expect(surface).not.toContain(TEST_PRIVATE_KEY);
    }
  });

  it('keeps the key out of rejection messages', () => {
    const badKeys: Hex[] = [
      `0x${'00'.repeat(32)}`,
      `0x${'ff'.repeat(32)}`,
      '0x1234',
      `0x${'ab'.repeat(32)}`.slice(0, 40) as Hex,
    ];

    for (const key of badKeys) {
      let message = '';
      try {
        createAttestationSigner({
          privateKey: key,
          chainId: VECTOR.chainId,
          reviewGatewayAddress: VECTOR.gateway,
        });
      } catch (err) {
        message = (err as Error).message;
      }

      expect(message).not.toBe('');
      expect(message).not.toContain(key);
      expect(message).not.toContain(key.slice(2));

      // viem reports an out-of-range key as a decimal integer; that must not
      // survive either. Only checked when the decimal is long enough that a
      // match could not be incidental.
      const decimal = BigInt(key).toString(10);
      if (decimal.length >= 20) expect(message).not.toContain(decimal);
    }
  });
});

describe('createAttestationSignerFromEnv', () => {
  it('wires the signer from validated configuration', () => {
    const env = loadEnv(
      envWith({
        RECORD_SERVER_PRIVATE_KEY: TEST_PRIVATE_KEY,
        REVIEW_GATEWAY_ADDRESS: VECTOR.gateway,
        CHAIN_ID: String(VECTOR.chainId),
      }),
    );

    const s = createAttestationSignerFromEnv(env);

    expect(s.address).toBe(privateKeyToAddress(TEST_PRIVATE_KEY));
    expect(s.domain.chainId).toBe(VECTOR.chainId);
    expect(s.domain.verifyingContract).toBe(VECTOR.gateway);
    expect(s.hash(FREE_ATTESTATION)).toBe(VECTOR.digest);
  });
});

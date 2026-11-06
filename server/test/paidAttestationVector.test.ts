import { describe, expect, it } from 'vitest';
import { hashTypedData } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import type { Hex } from 'viem';
import { createAttestationSigner } from '../src/signing/signer.js';
import { ATTESTATION_TYPES, PRIMARY_TYPE, attestationDomain } from '../src/signing/attestation.js';
import { REVIEW_TYPE, ZERO_BYTES32 } from '../src/signing/reviewContent.js';
import {
  PAID_VECTOR_ATTESTATION,
  PAID_VECTOR_CHAIN_ID,
  PAID_VECTOR_DIGEST,
  PAID_VECTOR_GATEWAY,
  PAID_VECTOR_NULLIFIER_DECIMAL,
  PAID_VECTOR_PRIVATE_KEY,
  PAID_VECTOR_SIGNATURE,
  PAID_VECTOR_SIGNER,
} from './paidAttestationVector.js';
import { VECTOR_DIGEST, VECTOR_SIGNATURE } from './attestationVector.js';

/**
 * Guards the paid-review fixture.
 *
 * Every expectation is a frozen literal from `paidAttestationVector.ts`. The
 * production signer is invoked and its output compared against them — the
 * expectations are never recomputed from the schema under test, because a
 * fixture that derives its own answers moves whenever the implementation does
 * and so proves nothing.
 */
describe('the paid-review acceptance vector', () => {
  const signer = () =>
    createAttestationSigner({
      privateKey: PAID_VECTOR_PRIVATE_KEY,
      chainId: PAID_VECTOR_CHAIN_ID,
      reviewGatewayAddress: PAID_VECTOR_GATEWAY,
    });

  describe('the production signer still reproduces it', () => {
    it('derives the recorded signer address', () => {
      expect(signer().address).toBe(PAID_VECTOR_SIGNER);
      expect(privateKeyToAddress(PAID_VECTOR_PRIVATE_KEY)).toBe(PAID_VECTOR_SIGNER);
    });

    it('hashes to the recorded digest', () => {
      expect(signer().hash(PAID_VECTOR_ATTESTATION)).toBe(PAID_VECTOR_DIGEST);
    });

    it('produces the recorded signature', async () => {
      // RFC 6979 makes this deterministic, so it is an exact comparison against
      // a literal rather than a verification.
      expect(await signer().sign(PAID_VECTOR_ATTESTATION)).toBe(PAID_VECTOR_SIGNATURE);
    });

    it('recovers the recorded signer from the recorded signature', async () => {
      await expect(signer().recover(PAID_VECTOR_ATTESTATION, PAID_VECTOR_SIGNATURE)).resolves.toBe(
        PAID_VECTOR_SIGNER,
      );
    });

    it('verifies the recorded signature against the recorded fields', async () => {
      await expect(signer().verify(PAID_VECTOR_ATTESTATION, PAID_VECTOR_SIGNATURE)).resolves.toBe(
        true,
      );
    });
  });

  describe('it is a paid review', () => {
    it('carries the paid review type', () => {
      expect(PAID_VECTOR_ATTESTATION.reviewType).toBe(REVIEW_TYPE.PAID);
      expect(PAID_VECTOR_ATTESTATION.reviewType).toBe(1);
    });

    it('carries a non-zero receipt id', () => {
      expect(PAID_VECTOR_ATTESTATION.receiptId).not.toBe(ZERO_BYTES32);
      expect(PAID_VECTOR_ATTESTATION.receiptId).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('differs from the free vector in both the digest and the signature', () => {
      expect(PAID_VECTOR_DIGEST).not.toBe(VECTOR_DIGEST);
      expect(PAID_VECTOR_SIGNATURE).not.toBe(VECTOR_SIGNATURE);
    });
  });

  describe('every signed field is bound', () => {
    // One valid mutation per field. The digest is taken from the production
    // signer; only the inputs vary, so a field that does not move the digest is
    // a field the signature does not cover.
    const baseline = () => signer().hash(PAID_VECTOR_ATTESTATION);

    const mutations: ReadonlyArray<readonly [string, Partial<typeof PAID_VECTOR_ATTESTATION>]> = [
      ['agentId', { agentId: 18446744073709551618n }],
      ['nullifier', { nullifier: `0x${'12'.repeat(32)}` as Hex }],
      ['reviewer', { reviewer: '0x5555555555555555555555555555555555555555' }],
      ['expiry', { expiry: 1850000001n }],
      ['value', { value: 92n }],
      ['feedbackHash', { feedbackHash: `0x${'45'.repeat(32)}` as Hex }],
      ['receiptId', { receiptId: `0x${'66'.repeat(32)}` as Hex }],
    ];

    it.each(mutations)('changing %s changes the digest', (_field, mutation) => {
      expect(signer().hash({ ...PAID_VECTOR_ATTESTATION, ...mutation })).not.toBe(baseline());
    });

    it('changing the signature no longer verifies', async () => {
      await expect(
        signer().verify({ ...PAID_VECTOR_ATTESTATION, value: 92n }, PAID_VECTOR_SIGNATURE),
      ).resolves.toBe(false);
    });

    describe('fields the validator will not let through the signer', () => {
      /**
       * Hash an attestation without passing it through `validateAttestation`.
       *
       * `valueDecimals` must be 0 and `reviewType` must be 0 or 1, so the only
       * mutations of them are ones the signer refuses before it ever hashes.
       * That refusal is correct, but it leaves the question this block exists to
       * answer — whether the signature covers the field at all — untested.
       *
       * The domain and types come from production; only the message varies. The
       * baseline assertion below ties this harness back to the frozen digest,
       * so a drifting schema cannot make these comparisons vacuous.
       */
      const rawDigest = (message: Record<string, unknown>): Hex =>
        hashTypedData({
          domain: attestationDomain(PAID_VECTOR_CHAIN_ID, PAID_VECTOR_GATEWAY),
          types: ATTESTATION_TYPES,
          primaryType: PRIMARY_TYPE,
          message: message as never,
        });

      it('reproduces the frozen digest when nothing is changed', () => {
        // Without this, a mismatched harness would make every mutation below
        // "differ" for the wrong reason.
        expect(rawDigest({ ...PAID_VECTOR_ATTESTATION })).toBe(PAID_VECTOR_DIGEST);
      });

      it('changing valueDecimals changes the digest', () => {
        expect(rawDigest({ ...PAID_VECTOR_ATTESTATION, valueDecimals: 1 })).not.toBe(
          PAID_VECTOR_DIGEST,
        );
      });

      it('changing reviewType changes the digest', () => {
        // 1 -> 0 is the free/paid flip the gateway's entry points distinguish.
        expect(rawDigest({ ...PAID_VECTOR_ATTESTATION, reviewType: 0 })).not.toBe(
          PAID_VECTOR_DIGEST,
        );
      });

      it('leaves the signer validation intact', async () => {
        // The bypass is local to this block: the production signer still
        // refuses the same mutations rather than hashing them.
        await expect(
          signer().sign({ ...PAID_VECTOR_ATTESTATION, valueDecimals: 1 }),
        ).rejects.toThrow();
        await expect(
          signer().sign({ ...PAID_VECTOR_ATTESTATION, reviewType: 0 }),
        ).rejects.toThrow();
      });
    });
  });

  describe('the domain is bound too', () => {
    it('a different chain yields a different digest', () => {
      const otherChain = createAttestationSigner({
        privateKey: PAID_VECTOR_PRIVATE_KEY,
        chainId: 1,
        reviewGatewayAddress: PAID_VECTOR_GATEWAY,
      });

      expect(otherChain.hash(PAID_VECTOR_ATTESTATION)).not.toBe(PAID_VECTOR_DIGEST);
    });

    it('a different gateway yields a different digest', () => {
      const otherGateway = createAttestationSigner({
        privateKey: PAID_VECTOR_PRIVATE_KEY,
        chainId: PAID_VECTOR_CHAIN_ID,
        reviewGatewayAddress: '0x9999999999999999999999999999999999999999',
      });

      expect(otherGateway.hash(PAID_VECTOR_ATTESTATION)).not.toBe(PAID_VECTOR_DIGEST);
    });
  });

  describe('the encoding the gateway requires', () => {
    it('is 65 bytes with canonical v and low s', () => {
      // _recoverStrict rejects anything else.
      expect(PAID_VECTOR_SIGNATURE).toMatch(/^0x[0-9a-f]{130}$/);

      const v = Number.parseInt(PAID_VECTOR_SIGNATURE.slice(130, 132), 16);
      expect([27, 28]).toContain(v);

      expect(BigInt(`0x${PAID_VECTOR_SIGNATURE.slice(66, 130)}`)).toBeLessThanOrEqual(
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n,
      );
    });
  });

  describe('the recorded values are internally consistent', () => {
    it('states the nullifier decimal that matches the signed bytes32', () => {
      // Both forms are frozen; this checks the pair, so the Solidity fixture
      // and any future prepare-side test cannot disagree about which human.
      expect(BigInt(PAID_VECTOR_ATTESTATION.nullifier).toString(10)).toBe(
        PAID_VECTOR_NULLIFIER_DECIMAL,
      );
    });

    it('uses an agentId past uint64', () => {
      expect(PAID_VECTOR_ATTESTATION.agentId).toBe(2n ** 64n + 1n);
      expect(PAID_VECTOR_ATTESTATION.agentId).toBeGreaterThan(2n ** 53n);
    });
  });
});

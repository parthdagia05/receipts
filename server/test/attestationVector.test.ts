import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { createAttestationSigner } from '../src/signing/signer.js';
import {
  VECTOR_ATTESTATION,
  VECTOR_CHAIN_ID,
  VECTOR_CONTENT,
  VECTOR_DIGEST,
  VECTOR_GATEWAY,
  VECTOR_NULLIFIER_DECIMAL,
  VECTOR_PRIVATE_KEY,
  VECTOR_SIGNATURE,
  VECTOR_SIGNER,
} from './attestationVector.js';

/**
 * Guards the cross-language fixture.
 *
 * `test/RecordServerAcceptance.t.sol` hardcodes these same values and feeds
 * them to the real ReviewGateway. If the TypeScript signer ever stops producing
 * exactly this signature, the Solidity test would keep passing against a stale
 * vector and the drift would go unnoticed — so this asserts the vector is still
 * what the implementation emits.
 */
describe('the Solidity acceptance vector', () => {
  const signer = () =>
    createAttestationSigner({
      privateKey: VECTOR_PRIVATE_KEY,
      chainId: VECTOR_CHAIN_ID,
      reviewGatewayAddress: VECTOR_GATEWAY,
    });

  it('is signed by the address the Solidity test deploys with', () => {
    expect(signer().address).toBe(VECTOR_SIGNER);
    expect(privateKeyToAddress(VECTOR_PRIVATE_KEY)).toBe(VECTOR_SIGNER);
  });

  it('still hashes to the recorded digest', () => {
    expect(signer().hash(VECTOR_ATTESTATION)).toBe(VECTOR_DIGEST);
  });

  it('still produces the recorded signature', async () => {
    // ECDSA here is deterministic (RFC 6979), so this is an exact comparison
    // rather than a verification.
    expect(await signer().sign(VECTOR_ATTESTATION)).toBe(VECTOR_SIGNATURE);
  });

  it('verifies the recorded signature against the recorded fields', async () => {
    await expect(signer().verify(VECTOR_ATTESTATION, VECTOR_SIGNATURE)).resolves.toBe(true);
  });

  it('recovers to the recorded signer', async () => {
    await expect(signer().recover(VECTOR_ATTESTATION, VECTOR_SIGNATURE)).resolves.toBe(
      VECTOR_SIGNER,
    );
  });

  it('commits feedbackHash to the recorded content', () => {
    expect(VECTOR_ATTESTATION.feedbackHash).toBe(keccak256(toBytes(VECTOR_CONTENT)));
  });

  it('carries the nullifier in its bytes32 form', () => {
    expect(BigInt(VECTOR_ATTESTATION.nullifier).toString(10)).toBe(VECTOR_NULLIFIER_DECIMAL);
  });

  it('keeps an agentId beyond double precision exact', () => {
    expect(VECTOR_ATTESTATION.agentId).toBe(2n ** 53n + 1n);
    expect(VECTOR_ATTESTATION.agentId.toString(10)).toBe('9007199254740993');
  });

  it('is in the encoding the gateway accepts', async () => {
    // 65 bytes, canonical v, low-s — what _recoverStrict requires.
    const signature = await signer().sign(VECTOR_ATTESTATION);

    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    const v = Number.parseInt(signature.slice(130, 132), 16);
    expect([27, 28]).toContain(v);
    expect(BigInt(`0x${signature.slice(66, 130)}`)).toBeLessThanOrEqual(
      0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n,
    );
  });

  it('does not verify once a signed field is changed', async () => {
    // The same mutation the Solidity negative test applies.
    await expect(
      signer().verify(
        { ...VECTOR_ATTESTATION, feedbackHash: `0x${'ee'.repeat(32)}` },
        VECTOR_SIGNATURE,
      ),
    ).resolves.toBe(false);
  });
});

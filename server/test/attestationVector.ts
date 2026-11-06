import type { Address, Hex } from 'viem';
import type { Attestation } from '../src/signing/attestation.js';

/**
 * A golden free-review attestation, produced by the real TypeScript signer and
 * consumed by the Solidity acceptance test in
 * `test/RecordServerAcceptance.t.sol`.
 *
 * The same literals appear on both sides of the language boundary. Neither can
 * drift silently:
 *
 *   - change the TypeScript signer, encoder or schema, and
 *     `attestationVector.test.ts` fails, because the signature it regenerates
 *     no longer matches `VECTOR_SIGNATURE`;
 *   - change the Solidity struct, typehash or domain, and the Foundry test
 *     fails, because `_recoverStrict` no longer recovers `VECTOR_SIGNER`.
 *
 * Every value here is a frozen literal — nothing is derived, hashed or
 * converted at load time. That is deliberate: a fixture that recomputes its own
 * expectations from the production schema cannot detect a change to that
 * schema, because both sides would move together. `keccak256`, `BigInt` and the
 * typed-data encoder are therefore all absent from this file.
 *
 * Test-only key, generated for this fixture and used nowhere else.
 */
export const VECTOR_PRIVATE_KEY: Hex =
  '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';

/** The address `VECTOR_PRIVATE_KEY` derives to; the gateway's recordServerSigner. */
export const VECTOR_SIGNER: Address = '0x5d5c99EdF529335160FF180fA141Dd4967fc00D2';

/** The EIP-712 domain the vector was signed under. */
export const VECTOR_CHAIN_ID = 11155111;
export const VECTOR_GATEWAY: Address = '0x2222222222222222222222222222222222222222';

/** The review text `feedbackHash` commits to. */
export const VECTOR_CONTENT = 'Settled the refund without being asked twice.';

/** The World ID nullifier in the decimal form the Portal returns. */
export const VECTOR_NULLIFIER_DECIMAL = '98765432109876543210987654321098765432109876543210';

/** The base URL the Record Server derives `feedbackURI` from, in fixtures. */
export const VECTOR_CONTENT_BASE_URL = 'https://receipts.test';

/**
 * The attestation itself, field for field as signed.
 *
 * `agentId` is 2^53 + 1 on purpose: it survives the round trip only if nothing
 * on either side of the boundary routes it through a double.
 *
 * `feedbackURI` is `<base>/reviews/<feedbackHash>` — what the Record Server
 * derives rather than accepts, which is what keeps the published pointer from
 * being substituted. It is signed, so it moves the digest.
 */
export const VECTOR_ATTESTATION: Attestation = {
  agentId: 9007199254740993n,
  nullifier: '0x00000000000000000000004393fb25a23480e82908ce2957cfb667d751c67eea',
  reviewer: '0x3333333333333333333333333333333333333333',
  expiry: 1800000000n,
  value: 73n,
  valueDecimals: 0,
  feedbackHash: '0x5441718c0a105af12067d69f5efdb50b1a6ad0ea5cba93fdf81f76bf821e085d',
  feedbackURI:
    'https://receipts.test/reviews/0x5441718c0a105af12067d69f5efdb50b1a6ad0ea5cba93fdf81f76bf821e085d',
  reviewType: 0,
  receiptId: '0x0000000000000000000000000000000000000000000000000000000000000000',
};

/** The EIP-712 digest the gateway will recover against. */
export const VECTOR_DIGEST: Hex =
  '0xdb4c7cb6c3242d27f9bd96ed1a6139c245935c3daa12e709c6640e31ca1d830f';

/** The signature the real `createAttestationSigner` produced over the above. */
export const VECTOR_SIGNATURE: Hex =
  '0xc7abfb85551eb5b166c1bbfa3d7c8612b52777bd1a6c83bd7749585326f1549a3f2a7e69140cdcf637034b6dec2111a1fbcfcc62ca2738313fb2236198030bdd1b';

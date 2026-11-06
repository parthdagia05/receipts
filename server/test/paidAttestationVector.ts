import type { Address, Hex } from 'viem';
import type { Attestation } from '../src/signing/attestation.js';

/**
 * A golden paid-review attestation, produced by the real TypeScript signer.
 *
 * Companion to the free-review vector in `attestationVector.ts`, and the input
 * the Solidity paid acceptance test will consume.
 *
 * Every value here is a frozen literal — nothing is derived, hashed or
 * converted at load time. That is deliberate: a fixture that recomputes its own
 * expectations from the production schema cannot detect a change to that
 * schema, because both sides would move together. `keccak256`, `BigInt` and the
 * typed-data encoder are therefore all absent from this file.
 *
 * The values originate from one invocation of `createAttestationSigner` with
 * `VECTOR_PRIVATE_KEY` under the fixed domain below;
 * `paidAttestationVector.test.ts` asserts the signer still reproduces them.
 *
 * The free vector uses the same test-only key and domain, so the two differ in
 * every signed field — nothing can be confused for the other.
 */

/**
 * Same test-only key as the free vector; used nowhere outside these fixtures.
 *
 * Written out rather than built with `repeat`, so the fixture states its inputs
 * as plainly as it states its expected outputs.
 */
export const PAID_VECTOR_PRIVATE_KEY: Hex =
  '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';

/** The address that key derives to; the gateway's `recordServerSigner`. */
export const PAID_VECTOR_SIGNER: Address = '0x5d5c99EdF529335160FF180fA141Dd4967fc00D2';

/** The EIP-712 domain the vector was signed under. */
export const PAID_VECTOR_CHAIN_ID = 11155111;
export const PAID_VECTOR_GATEWAY: Address = '0x2222222222222222222222222222222222222222';

/** The review text `feedbackHash` commits to, recorded for the eventual URI. */
export const PAID_VECTOR_CONTENT = 'Paid in USDC, delivered the audit a day early.';

/** The World ID nullifier in the decimal form the Portal returns. */
export const PAID_VECTOR_NULLIFIER_DECIMAL = '31415926535897932384626433832795028841971693993751';

/** The base URL the Record Server derives `feedbackURI` from, in fixtures. */
export const PAID_VECTOR_CONTENT_BASE_URL = 'https://receipts.test';

/**
 * The attestation itself, field for field as signed.
 *
 * `agentId` is 2^64 + 1: past both double precision and uint64, so a narrowing
 * anywhere on either side of the language boundary shows up as a mismatch
 * rather than as a silently wrong agent.
 *
 * `feedbackURI` is `<base>/reviews/<feedbackHash>` — what the Record Server
 * derives rather than accepts, which is what keeps the published pointer from
 * being substituted. It is signed, so it moves the digest.
 */
export const PAID_VECTOR_ATTESTATION: Attestation = {
  agentId: 18446744073709551617n,
  nullifier: '0x0000000000000000000000157ee2de15fd7333af23d76e19c99051cfd1fd3f17',
  reviewer: '0x4444444444444444444444444444444444444444',
  expiry: 1850000000n,
  value: 91n,
  valueDecimals: 0,
  feedbackHash: '0x7c43dd8a842b6b95a9b1e0d43296a4948d6719d0e2e2f6350d3266124173232c',
  feedbackURI:
    'https://receipts.test/reviews/0x7c43dd8a842b6b95a9b1e0d43296a4948d6719d0e2e2f6350d3266124173232c',
  reviewType: 1,
  receiptId: '0x3841de09140455934c197fe8f768c7ea23d15c63cfc07e4ecd893f60bbab3405',
};

/** The EIP-712 digest the gateway will recover against. */
export const PAID_VECTOR_DIGEST: Hex =
  '0xff84cbcc6e9211dd1d02b381d2d46a72b1bf2e598a987a0f497e793e961f3d31';

/** The signature the real `createAttestationSigner` produced over the above. */
export const PAID_VECTOR_SIGNATURE: Hex =
  '0x8bb0ad28dc011cd063c8e440dc5ab79d3fc04ab2b5f5012c293812ee7cc4cefd17c8bbccb47ee641202409ae068ab75a6a1889b15d6f3989db7682126abbf88f1b';

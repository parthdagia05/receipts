import type { Address, Hex } from 'viem';
import { REVIEW_TYPE, ZERO_BYTES32 } from '../src/signing/attestation.js';
import type { Attestation } from '../src/signing/attestation.js';

/**
 * Deterministic test key: 32 bytes of 0x11. Clearly synthetic and well inside
 * the secp256k1 scalar range. Never a real credential, and never read from the
 * environment.
 */
export const TEST_PRIVATE_KEY: Hex = `0x${'11'.repeat(32)}`;

/**
 * Cross-implementation reference vector.
 *
 * `attestationTypehash`, `domainSeparator` and `digest` were produced with
 * `cast`, replicating ReviewGateway's `_ATTESTATION_TYPEHASH`,
 * `_domainSeparator()` and `_digest()` over FREE_ATTESTATION. They pin the
 * TypeScript encoding to the Solidity one: if either drifts, the digest test
 * fails rather than the gateway silently rejecting live signatures.
 */
export const VECTOR = {
  chainId: 11155111,
  gateway: `0x${'22'.repeat(20)}` as Address,
  attestationTypehash: '0x2397e9cda061985ad7c35fd94760f20a13cb7a498d6d1dd72625af40ad788911' as Hex,
  domainSeparator: '0x2d7446dcfe4946ca212178034052d803edc540def02dad26154cea40e44d4bd9' as Hex,
  digest: '0xcd0c006c1b64fc0a0c5d872275004ff79d3afa6c379793e599eac2efcf514bf7' as Hex,
} as const;

/** The free-path attestation the reference digest was computed over. */
export const FREE_ATTESTATION: Attestation = {
  agentId: 42n,
  nullifier: `0x${'11'.repeat(32)}`,
  reviewer: `0x${'33'.repeat(20)}`,
  expiry: 1_800_000_000n,
  value: 80n,
  valueDecimals: 0,
  feedbackHash: `0x${'44'.repeat(32)}`,
  // Derived from the feedbackHash above, as the Record Server derives it.
  feedbackURI: `https://receipts.test/reviews/0x${'44'.repeat(32)}`,
  reviewType: REVIEW_TYPE.FREE,
  receiptId: ZERO_BYTES32,
};

/** A valid paid-path attestation, with optional field overrides. */
export function paidAttestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    ...FREE_ATTESTATION,
    value: 90n,
    reviewType: REVIEW_TYPE.PAID,
    receiptId: `0x${'55'.repeat(32)}`,
    ...overrides,
  };
}

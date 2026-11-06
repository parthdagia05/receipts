import { getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { REVIEW_TYPE, ZERO_BYTES32 } from '../src/signing/reviewContent.js';
import type { ReviewAuthorization } from '../src/signing/reviewAuthorization.js';

/**
 * Cross-implementation reference vector.
 *
 * `typehash`, `domainSeparator` and `digest` were produced with `cast`,
 * replicating the EIP-712 encoding the gateway's Solidity uses. They pin the
 * TypeScript encoding: if it drifts, a test fails rather than wallets being
 * asked to sign something the server will not recognize.
 */
export const AUTH_VECTOR = {
  chainId: 11155111,
  gateway: getAddress(`0x${'22'.repeat(20)}`) as Address,
  typehash: '0x0558b57e74dfd9bed342f0b87011b41809e5c17a05632823a59720016ec221a0' as Hex,
  domainSeparator: '0xc0f6bf84824f7b8bf8e35cf8bbf3768c3268a61287d8b732e49f50675fb45712' as Hex,
  digest: '0x760fd862b58603cbe0a82c459b34d5e7bfd9636d8bec66d308f38a031ac6de0c' as Hex,
} as const;

/** The nullifier the fixtures use, in both representations. */
export const FIXTURE_NULLIFIER_DECIMAL = '7';
export const FIXTURE_NULLIFIER_BYTES32: Hex = `0x${'00'.repeat(31)}07`;

/** The authorization the reference digest was computed over. */
export function authorization(overrides: Partial<ReviewAuthorization> = {}): ReviewAuthorization {
  return {
    agentId: 42n,
    nullifier: FIXTURE_NULLIFIER_BYTES32,
    reviewer: getAddress(`0x${'33'.repeat(20)}`),
    value: 80n,
    valueDecimals: 0,
    feedbackHash: `0x${'44'.repeat(32)}`,
    reviewType: REVIEW_TYPE.FREE,
    receiptId: ZERO_BYTES32,
    nonce: `0x${'55'.repeat(32)}`,
    deadline: 1_800_000_000n,
    ...overrides,
  };
}

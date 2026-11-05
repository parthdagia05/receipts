import { encodeAbiParameters, getAddress, isAddress, keccak256, toBytes } from 'viem';
import type { Address, Hex } from 'viem';

/**
 * The review fields shared by the wallet authorization and the on-chain
 * attestation.
 *
 * Both must agree exactly: the human authorizes these values, and the gateway
 * later checks the same ones, so the rules live here rather than in each signer.
 */
export interface ReviewContent {
  /** uint256. */
  readonly agentId: bigint;
  /** bytes32. The canonical form of the World ID nullifier. */
  readonly nullifier: Hex;
  readonly reviewer: Address;
  /** int128 on the wire; the gateway narrows it to 0..100. */
  readonly value: bigint;
  /** uint8. The gateway requires 0. */
  readonly valueDecimals: number;
  /** bytes32. May be zero. */
  readonly feedbackHash: Hex;
  /** uint8. 0 = free, 1 = paid. */
  readonly reviewType: number;
  /** bytes32. Zero on the free path, non-zero on the paid path. */
  readonly receiptId: Hex;
}

/**
 * reviewType values, matching `_REVIEW_FREE` / `_REVIEW_PAID` / `_REVIEW_WALLET`.
 *
 * WALLET is wallet-verified only: it proves an address authorized the review and
 * says nothing about whether one human controls several addresses. It is never
 * a personhood claim.
 */
export const REVIEW_TYPE = {
  FREE: 0,
  PAID: 1,
  WALLET: 2,
} as const;

export type ReviewType = (typeof REVIEW_TYPE)[keyof typeof REVIEW_TYPE];

export const ZERO_BYTES32: Hex = `0x${'00'.repeat(32)}`;
export const ZERO_ADDRESS: Address = `0x${'00'.repeat(20)}`;

export const UINT64_MAX = 2n ** 64n - 1n;
export const UINT256_MAX = 2n ** 256n - 1n;

/** The gateway's accepted rating range. */
export const MIN_VALUE = 0n;
export const MAX_VALUE = 100n;
/** The only `valueDecimals` the gateway accepts. */
export const REQUIRED_VALUE_DECIMALS = 0;

/** One rejected field. These are public review values, so the offending one is
 *  included to make the failure diagnosable. */
export interface ContentIssue {
  readonly field: string;
  readonly message: string;
}

export function isBytes32(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

const DECIMAL_PATTERN = /^[0-9]+$/;

/**
 * Domain for wallet-review nullifiers: `keccak256("ReceiptsWalletReview(v1)")`.
 * Mirrors `_WALLET_NULLIFIER_DOMAIN` in ReviewGateway.sol.
 */
export const WALLET_NULLIFIER_DOMAIN: Hex = keccak256(toBytes('ReceiptsWalletReview(v1)'));

/**
 * The nullifier a wallet review for `reviewer` must carry.
 *
 * `keccak256(abi.encode(WALLET_NULLIFIER_DOMAIN, reviewer))`, identical to the
 * gateway's `walletNullifier(address)`. Pinned against the Solidity output by a
 * shared vector in both test suites.
 */
export function walletNullifier(reviewer: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }],
      [WALLET_NULLIFIER_DOMAIN, getAddress(reviewer)],
    ),
  );
}

/** Raised when a World ID nullifier cannot be converted. */
export class InvalidNullifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNullifierError';
  }
}

/**
 * Convert a World ID nullifier from the decimal field element the API returns
 * into the bytes32 the gateway's `Attestation` carries.
 *
 * Done exactly once, when a challenge is created, and the result is persisted.
 * If the wallet signed the decimal form while the gateway saw bytes32, the human
 * would have authorized a different value than the one reaching the chain —
 * so there is one conversion, at one point, and everything downstream reuses it.
 *
 * @throws InvalidNullifierError when the value is not a non-zero uint256 decimal.
 */
export function nullifierToBytes32(decimal: string): Hex {
  if (typeof decimal !== 'string' || !DECIMAL_PATTERN.test(decimal)) {
    throw new InvalidNullifierError('nullifier must be a decimal string');
  }
  // 78 digits is uint256's decimal width; longer cannot be in range, and the
  // bound keeps BigInt from parsing an unbounded string.
  if (decimal.length > 78) {
    throw new InvalidNullifierError('nullifier must fit in uint256');
  }

  const value = BigInt(decimal);
  if (value === 0n) {
    throw new InvalidNullifierError('nullifier must not be zero');
  }
  if (value > UINT256_MAX) {
    throw new InvalidNullifierError('nullifier must fit in uint256');
  }

  return `0x${value.toString(16).padStart(64, '0')}`;
}

/**
 * Every rule the gateway enforces on the shared review fields.
 *
 * Returns the issues rather than throwing, so a caller can add its own — the
 * attestation's `expiry`, a challenge's `deadline` — and report them together.
 * Each rule mirrors a `require` in `submitFreeReview` / `submitPaidReview` or
 * `_verifyAttestation`.
 */
export function reviewContentIssues(content: ReviewContent): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const fail = (field: string, message: string): void => {
    issues.push({ field, message });
  };

  if (typeof content.agentId !== 'bigint') {
    fail('agentId', 'must be a bigint');
  } else if (content.agentId < 0n || content.agentId > UINT256_MAX) {
    fail('agentId', `must fit in uint256, got ${content.agentId}`);
  }

  if (!isBytes32(content.nullifier)) {
    fail('nullifier', 'must be a 0x-prefixed 32-byte hex string');
  } else if (content.nullifier.toLowerCase() === ZERO_BYTES32) {
    fail('nullifier', 'must not be zero');
  }

  if (typeof content.reviewer !== 'string' || !isAddress(content.reviewer, { strict: false })) {
    fail('reviewer', 'must be a 20-byte hex address');
  } else if (getAddress(content.reviewer) === getAddress(ZERO_ADDRESS)) {
    fail('reviewer', 'must not be the zero address');
  }

  if (typeof content.value !== 'bigint') {
    fail('value', 'must be a bigint');
  } else if (content.value < MIN_VALUE || content.value > MAX_VALUE) {
    fail('value', `must be between ${MIN_VALUE} and ${MAX_VALUE}, got ${content.value}`);
  }

  if (content.valueDecimals !== REQUIRED_VALUE_DECIMALS) {
    fail(
      'valueDecimals',
      `must be ${REQUIRED_VALUE_DECIMALS}, got ${String(content.valueDecimals)}`,
    );
  }

  if (!isBytes32(content.feedbackHash)) {
    fail('feedbackHash', 'must be a 0x-prefixed 32-byte hex string');
  }

  const isFree = content.reviewType === REVIEW_TYPE.FREE;
  const isPaid = content.reviewType === REVIEW_TYPE.PAID;
  const isWallet = content.reviewType === REVIEW_TYPE.WALLET;
  if (!isFree && !isPaid && !isWallet) {
    fail(
      'reviewType',
      `must be ${REVIEW_TYPE.FREE} (free), ${REVIEW_TYPE.PAID} (paid) or ${REVIEW_TYPE.WALLET} (wallet), got ${String(content.reviewType)}`,
    );
  }

  // The gateway recomputes this and rejects anything else, so a wallet review
  // can never carry a World ID nullifier — nor a World ID review a wallet one.
  if (
    isWallet &&
    isBytes32(content.nullifier) &&
    typeof content.reviewer === 'string' &&
    isAddress(content.reviewer, { strict: false }) &&
    content.nullifier.toLowerCase() !== walletNullifier(content.reviewer)
  ) {
    fail('nullifier', 'must be the wallet nullifier of the reviewer for a wallet review');
  }

  if (!isBytes32(content.receiptId)) {
    fail('receiptId', 'must be a 0x-prefixed 32-byte hex string');
  } else {
    const isZero = content.receiptId.toLowerCase() === ZERO_BYTES32;
    if ((isFree || isWallet) && !isZero) {
      fail('receiptId', `must be zero for a ${isWallet ? 'wallet' : 'free'} review`);
    } else if (isPaid && isZero) {
      fail('receiptId', 'must be nonzero for a paid review');
    }
  }

  return issues;
}

/**
 * The case-canonical form: lowercase hex, checksummed address.
 *
 * Case does not affect an EIP-712 digest, so canonicalizing does not change
 * what a signature covers — it only makes stored and compared values identical.
 * Assumes the content has already passed `reviewContentIssues`.
 */
export function canonicalizeReviewContent(content: ReviewContent): ReviewContent {
  return {
    agentId: content.agentId,
    nullifier: content.nullifier.toLowerCase() as Hex,
    reviewer: getAddress(content.reviewer),
    value: content.value,
    valueDecimals: content.valueDecimals,
    feedbackHash: content.feedbackHash.toLowerCase() as Hex,
    reviewType: content.reviewType,
    receiptId: content.receiptId.toLowerCase() as Hex,
  };
}

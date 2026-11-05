import { getAddress, hashTypedData } from 'viem';
import type { Address, Hex, TypedDataDomain } from 'viem';
import {
  UINT64_MAX,
  ZERO_ADDRESS,
  canonicalizeReviewContent,
  reviewContentIssues,
} from './reviewContent.js';
import type { ContentIssue, ReviewContent } from './reviewContent.js';

/**
 * What the reviewer's wallet signs: the exact review, plus a server-issued
 * nonce and a deadline.
 *
 * Distinct from the Record Server's attestation and deliberately so — this one
 * proves the human controls the wallet the World ID signal was bound to, and
 * consents to these values. `expiry` is absent: the human authorizes content,
 * and the server chooses the on-chain validity window when it signs.
 */
export interface ReviewAuthorization extends ReviewContent {
  /** bytes32. The challenge nonce; makes each authorization single-use. */
  readonly nonce: Hex;
  /** uint64. Unix seconds after which the challenge may no longer be spent. */
  readonly deadline: bigint;
}

/**
 * EIP-712 domain `name`.
 *
 * Deliberately not the gateway's "ReceiptsReviewGateway". A different primary
 * type already yields a different digest, so reuse would be safe in principle —
 * and a reviewer's signature could never pass as an attestation anyway, since
 * the gateway only accepts signatures recovering to `recordServerSigner`. A
 * separate domain makes that structural rather than an argument, for free.
 */
export const AUTHORIZATION_DOMAIN_NAME = 'ReceiptsReviewAuthorization';
export const AUTHORIZATION_DOMAIN_VERSION = '1';

/** Annotated, not inferred: a widening literal would broaden to `string` in an
 *  object property and be rejected by viem's typed-data generics. */
export const AUTHORIZATION_PRIMARY_TYPE: 'ReviewAuthorization' = 'ReviewAuthorization';

/**
 * The EIP-712 struct definition.
 *
 * The eight shared fields use the gateway's exact Solidity types, so the value
 * the wallet signs encodes identically to the one the gateway will check. Field
 * order is load-bearing — reordering changes the typehash.
 */
export const AUTHORIZATION_TYPES = {
  ReviewAuthorization: [
    { name: 'agentId', type: 'uint256' },
    { name: 'nullifier', type: 'bytes32' },
    { name: 'reviewer', type: 'address' },
    { name: 'value', type: 'int128' },
    { name: 'valueDecimals', type: 'uint8' },
    { name: 'feedbackHash', type: 'bytes32' },
    { name: 'reviewType', type: 'uint8' },
    { name: 'receiptId', type: 'bytes32' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

// `as const` is compile-time only; freeze the structure so nothing holding this
// exported reference can rename a field at runtime and silently change every
// digest the server asks a wallet to sign.
Object.freeze(AUTHORIZATION_TYPES);
Object.freeze(AUTHORIZATION_TYPES.ReviewAuthorization);
for (const field of AUTHORIZATION_TYPES.ReviewAuthorization) {
  Object.freeze(field);
}

/** The type string hashed into the typehash; pinned by a test. */
export const AUTHORIZATION_TYPE_STRING =
  'ReviewAuthorization(uint256 agentId,bytes32 nullifier,address reviewer,int128 value,uint8 valueDecimals,bytes32 feedbackHash,uint8 reviewType,bytes32 receiptId,bytes32 nonce,uint64 deadline)';

/**
 * The EIP-712 domain for a given deployment.
 *
 * Binds the real chain and the real ReviewGateway: a signature meant for one
 * deployment must not be replayable against another. Frozen before return, so
 * a holder cannot retarget it.
 */
export function authorizationDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
  // `loadEnv` already validates CHAIN_ID and REVIEW_GATEWAY_ADDRESS, so these
  // cannot fail in the running server. The check is here because this function
  // is also reachable from scripts and tests, where a zero address or a chain id
  // of 0 would produce a domain no wallet should be asked to sign — and a wrong
  // domain fails silently, as a signature nobody can verify.
  if (!Number.isSafeInteger(chainId) || chainId < 1) {
    throw new InvalidAuthorizationDomainError('chainId must be a positive integer');
  }

  // `getAddress` is the single gate: it throws on anything that is not a
  // 20-byte hex address, and otherwise returns the canonical EIP-55 form. A
  // mis-checksummed mixed-case address is normalized rather than refused, which
  // is harmless here — EIP-712 encodes an address as 20 bytes, so casing never
  // reaches the digest — and keeps this consistent with every other address
  // path in the server.
  let normalized: Address;
  try {
    normalized = getAddress(verifyingContract as string);
  } catch {
    throw new InvalidAuthorizationDomainError('verifyingContract must be a 20-byte hex address');
  }

  if (normalized === getAddress(ZERO_ADDRESS)) {
    throw new InvalidAuthorizationDomainError('verifyingContract must not be the zero address');
  }

  return Object.freeze({
    name: AUTHORIZATION_DOMAIN_NAME,
    version: AUTHORIZATION_DOMAIN_VERSION,
    chainId,
    // The normalized form, so the domain never carries a caller's spelling.
    verifyingContract: normalized,
  });
}

/** Raised when the domain cannot describe a real deployment. */
export class InvalidAuthorizationDomainError extends Error {
  constructor(message: string) {
    super(`Invalid authorization domain: ${message}`);
    this.name = 'InvalidAuthorizationDomainError';
  }
}

/** Aggregated validation failure; safe to log in full. */
export class AuthorizationValidationError extends Error {
  readonly issues: readonly ContentIssue[];

  constructor(issues: readonly ContentIssue[]) {
    const detail = issues.map((i) => `  - ${i.field}: ${i.message}`).join('\n');
    super(`Invalid review authorization:\n${detail}`);
    this.name = 'AuthorizationValidationError';
    this.issues = issues;
  }
}

const NONCE_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Check the authorization and return its canonical form.
 *
 * The shared review fields are checked by `reviewContentIssues`, the same rules
 * the attestation uses, so the human cannot be asked to authorize something the
 * gateway would reject. `nonce` and `deadline` are this struct's own.
 *
 * Whether the deadline is still in the future is not checked here: that is the
 * consuming endpoint's question, against a clock, and baking it in would make
 * this encoder time-dependent.
 *
 * @throws AuthorizationValidationError when any field is malformed.
 */
export function validateReviewAuthorization(auth: ReviewAuthorization): ReviewAuthorization {
  const issues: ContentIssue[] = reviewContentIssues(auth);

  if (typeof auth.nonce !== 'string' || !NONCE_PATTERN.test(auth.nonce)) {
    issues.push({ field: 'nonce', message: 'must be a 0x-prefixed 32-byte hex string' });
  }

  if (typeof auth.deadline !== 'bigint') {
    issues.push({ field: 'deadline', message: 'must be a bigint' });
  } else if (auth.deadline < 0n || auth.deadline > UINT64_MAX) {
    issues.push({ field: 'deadline', message: `must fit in uint64, got ${auth.deadline}` });
  }

  if (issues.length > 0) throw new AuthorizationValidationError(issues);

  return {
    ...canonicalizeReviewContent(auth),
    nonce: auth.nonce.toLowerCase() as Hex,
    deadline: auth.deadline,
  };
}

/** The typed data a wallet is asked to sign. */
export interface AuthorizationTypedData {
  readonly domain: TypedDataDomain;
  readonly types: typeof AUTHORIZATION_TYPES;
  readonly primaryType: 'ReviewAuthorization';
  readonly message: ReviewAuthorization;
}

/**
 * Build the typed data for one authorization.
 *
 * Validates first, so a challenge is never issued for content the gateway would
 * refuse — the wallet is only ever shown something that can actually settle.
 */
export function authorizationTypedData(
  auth: ReviewAuthorization,
  chainId: number,
  verifyingContract: Address,
): AuthorizationTypedData {
  return {
    domain: authorizationDomain(chainId, verifyingContract),
    types: AUTHORIZATION_TYPES,
    primaryType: AUTHORIZATION_PRIMARY_TYPE,
    message: validateReviewAuthorization(auth),
  };
}

/** The EIP-712 digest a wallet signature must cover. */
export function authorizationDigest(
  auth: ReviewAuthorization,
  chainId: number,
  verifyingContract: Address,
): Hex {
  return hashTypedData(authorizationTypedData(auth, chainId, verifyingContract));
}

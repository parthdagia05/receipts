import type { Address, Hex, TypedDataDomain } from 'viem';
import { UINT64_MAX, canonicalizeReviewContent, reviewContentIssues } from './reviewContent.js';

// Re-exported so the gateway's rules have one home while this module's public
// surface stays as it was.
export {
  MAX_VALUE,
  MIN_VALUE,
  REQUIRED_VALUE_DECIMALS,
  REVIEW_TYPE,
  ZERO_BYTES32,
  isBytes32,
  nullifierToBytes32,
} from './reviewContent.js';
export type { ReviewContent, ReviewType } from './reviewContent.js';

/**
 * The ReviewGateway attestation, mirroring the Solidity struct field-for-field.
 *
 * `signature` is deliberately absent: it is produced over these fields, not one
 * of them. Integers that can exceed Number.MAX_SAFE_INTEGER are `bigint`; the
 * two `uint8` fields stay `number`, where overflow is not representable.
 *
 * @see src/ReviewGateway.sol — `struct Attestation`
 */
export interface Attestation {
  /** uint256. The agent being reviewed. */
  readonly agentId: bigint;
  /** bytes32. World ID nullifier for (human, action). Must be nonzero. */
  readonly nullifier: Hex;
  /** address. The human's wallet. Must be nonzero. */
  readonly reviewer: Address;
  /** uint64. Unix seconds after which the gateway rejects the attestation. */
  readonly expiry: bigint;
  /** int128 on the wire; the gateway narrows it to 0..100. */
  readonly value: bigint;
  /** uint8. The gateway requires 0. */
  readonly valueDecimals: number;
  /** bytes32. Hash of the off-chain evidence. May be zero. */
  readonly feedbackHash: Hex;
  /** string. URI of the off-chain evidence. Signed, so the pointer the gateway
   *  publishes to ERC-8004 cannot be swapped by whoever relays the submission. */
  readonly feedbackURI: string;
  /** uint8. 0 = free, 1 = paid. */
  readonly reviewType: number;
  /** bytes32. Receipt to consume on the paid path; zero on the free path. */
  readonly receiptId: Hex;
}

/** EIP-712 domain `name`, matching `_NAME_HASH`'s preimage. */
export const DOMAIN_NAME = 'ReceiptsReviewGateway';
/** EIP-712 domain `version`, matching `_VERSION_HASH`'s preimage. */
export const DOMAIN_VERSION = '1';

/** Annotated, not inferred: a widening literal type would be broadened to
 *  `string` in an object property and rejected by viem's typed-data generics. */
export const PRIMARY_TYPE: 'Attestation' = 'Attestation';

/** Upper bound on the signed evidence URI. The gateway does not bound it, so
 *  this keeps an unbounded string out of calldata and out of the ERC-8004 event. */
export const MAX_FEEDBACK_URI_LENGTH = 2048;

/**
 * The EIP-712 struct definition.
 *
 * Field order is load-bearing: viem derives the type string from this array,
 * and a reordering yields a different typehash, so the gateway would reject
 * every signature. Kept in the contract's order.
 */
export const ATTESTATION_TYPES = {
  Attestation: [
    { name: 'agentId', type: 'uint256' },
    { name: 'nullifier', type: 'bytes32' },
    { name: 'reviewer', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { name: 'value', type: 'int128' },
    { name: 'valueDecimals', type: 'uint8' },
    { name: 'feedbackHash', type: 'bytes32' },
    { name: 'feedbackURI', type: 'string' },
    { name: 'reviewType', type: 'uint8' },
    { name: 'receiptId', type: 'bytes32' },
  ],
} as const;

// `as const` is erased at compile time, so freeze the schema structurally as
// well. Anything holding this exported reference could otherwise rename a field
// or change a type at runtime, which would silently alter the typehash and so
// every digest the server signs. Frozen at module load, before any caller runs.
Object.freeze(ATTESTATION_TYPES);
Object.freeze(ATTESTATION_TYPES.Attestation);
for (const field of ATTESTATION_TYPES.Attestation) {
  Object.freeze(field);
}

/**
 * The type string the contract hashes into `_ATTESTATION_TYPEHASH`.
 *
 * Duplicated from Solidity as a literal so a test can assert viem's derived
 * encoding still matches the deployed contract.
 */
export const ATTESTATION_TYPE_STRING =
  'Attestation(uint256 agentId,bytes32 nullifier,address reviewer,uint64 expiry,int128 value,uint8 valueDecimals,bytes32 feedbackHash,string feedbackURI,uint8 reviewType,bytes32 receiptId)';

/**
 * The EIP-712 domain for a given deployment.
 *
 * Computed from config rather than stored, so a chain or gateway change cannot
 * leave a stale domain behind.
 *
 * Frozen before it is returned: the signer exposes its domain, and a caller
 * editing that object must not be able to retarget the chain or gateway the
 * server signs for. All four fields are primitives, so a shallow freeze is
 * total.
 */
export function attestationDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
  return Object.freeze({
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract,
  });
}

/** One rejected field. Attestation fields are public review data, so the
 *  offending value is included to make the failure diagnosable. */
export interface AttestationIssue {
  readonly field: string;
  readonly message: string;
}

/** Aggregated attestation validation failure; safe to log in full. */
export class AttestationValidationError extends Error {
  readonly issues: readonly AttestationIssue[];

  constructor(issues: readonly AttestationIssue[]) {
    const detail = issues.map((i) => `  - ${i.field}: ${i.message}`).join('\n');
    super(`Invalid attestation:\n${detail}`);
    this.name = 'AttestationValidationError';
    this.issues = issues;
  }
}

function isBytes32(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Check every field the gateway checks, and return the canonical form.
 *
 * Runs before signing so the server cannot mint an attestation that is
 * guaranteed to revert: each rule here mirrors a `require` in
 * `submitFreeReview` / `submitPaidReview` or `_verifyAttestation`. Every issue
 * is collected before throwing.
 *
 * Normalization is case only — lowercase hex, checksummed address — which does
 * not affect the digest, so a validated attestation hashes identically to its
 * input.
 *
 * Freshness is not checked: whether `expiry` is far enough in the future is a
 * policy decision for the endpoint that issues attestations, not for the
 * encoder. Only the uint64 range is enforced here.
 *
 * @throws AttestationValidationError when any field is malformed or out of range.
 */
export function validateAttestation(att: Attestation): Attestation {
  // The shared review fields are checked once, in reviewContent, so the wallet
  // authorization and this attestation cannot drift apart on what the gateway
  // will accept. Only `expiry` is this signature's own concern.
  const issues: AttestationIssue[] = reviewContentIssues(att);

  if (typeof att.expiry !== 'bigint') {
    issues.push({ field: 'expiry', message: 'must be a bigint' });
  } else if (att.expiry < 0n || att.expiry > UINT64_MAX) {
    issues.push({ field: 'expiry', message: `must fit in uint64, got ${att.expiry}` });
  }

  // Attestation-only, like expiry: the wallet authorization does not carry a
  // URI, because the server derives it from the feedbackHash the human already
  // signed. Validated anyway — this is what gets published to ERC-8004.
  if (typeof att.feedbackURI !== 'string') {
    issues.push({ field: 'feedbackURI', message: 'must be a string' });
  } else if (att.feedbackURI.length === 0) {
    issues.push({ field: 'feedbackURI', message: 'must not be empty' });
  } else if (att.feedbackURI.length > MAX_FEEDBACK_URI_LENGTH) {
    issues.push({
      field: 'feedbackURI',
      message: `must be at most ${MAX_FEEDBACK_URI_LENGTH} characters, got ${att.feedbackURI.length}`,
    });
  }

  if (issues.length > 0) throw new AttestationValidationError(issues);

  return {
    ...canonicalizeReviewContent(att),
    expiry: att.expiry,
    feedbackURI: att.feedbackURI,
  };
}

import { hashSignal } from '@worldcoin/idkit-core/hashing';

/**
 * The credential this server accepts.
 *
 * `issuer_schema_id` 1 is Proof of Human; both it and the identifier are checked,
 * since the identifier alone is a free-form string in the SDK's type.
 */
export const PROOF_OF_HUMAN_IDENTIFIER = 'proof_of_human';
export const PROOF_OF_HUMAN_SCHEMA_ID = 1;

/*
 * Why `expires_at_min` is validated but never compared against the clock.
 *
 * It is Unix seconds — the SDK's own example computes `Date.now() / 1000 + …`,
 * and `world-id-primitives` declares `expires_at: u64` as "unix seconds".
 *
 * It is a *lower bound the RP requests*, not the credential's expiry:
 * `CredentialRequest` takes `expires_at_min` as a request option documented as
 * "Require credential to be valid for at least one year", sent as null when
 * unset. The response reports the attested bound. The credential's real expiry
 * (`expires_at`) is never exposed — the `_min` suffix is the protocol's
 * privacy-preserving range query, the same pattern as `genesis_issued_at_min`.
 *
 * Expiry is enforced inside the zero-knowledge circuit. The v4 spec lists among
 * the constraints the Uniqueness Proof guarantees: "Credential is not expired."
 * An expired credential therefore cannot produce a valid proof, and the Portal
 * rejects it when it verifies the proof. Consistently, there is no verify-time
 * error code for an expired credential — `timestamp_too_old`,
 * `timestamp_too_far_in_future`, `invalid_timestamp` and `rp_signature_expired`
 * all concern the rp_context signature window, not the credential.
 *
 * So a local `expires_at_min > now` rejection would add no security and would
 * enforce a minimum this server never asked for, turning valid proofs away. To
 * require credential longevity, set `expires_at_min` on the IDKit
 * `CredentialRequest` and then assert the response meets the value requested —
 * a request-side change, not a verification-side one.
 *
 * Unverified: no document states the Portal's behaviour given a *past*
 * `expires_at_min`, and no inclusive/exclusive comparison rule is published.
 */

/** Environments a proof may be produced in. */
export type WorldIdEnvironment = 'production' | 'staging' | 'sandbox';

const ENVIRONMENTS: readonly string[] = ['production', 'staging', 'sandbox'];

/**
 * One credential response, mirroring the SDK's `ResponseItemV4`.
 *
 * Restated rather than imported as a type so the runtime validator and the
 * static shape cannot drift: the SDK describes what IDKit produces, but this
 * arrives as untrusted JSON from a client.
 *
 * The index signature is deliberate. These objects are forwarded to the Portal
 * as they arrived, so an item may carry fields this type does not name —
 * `sybil_score` on a Self Check item, or anything a later World App adds.
 */
export interface ProofResponseItem {
  readonly identifier: string;
  readonly issuer_schema_id: number;
  readonly nullifier: string;
  readonly proof: readonly string[];
  readonly expires_at_min: number;
  readonly signal_hash?: string;
  readonly [extra: string]: unknown;
}

/**
 * The IDKit v4 uniqueness result, as forwarded by the frontend.
 *
 * Describes the fields this server reads; it does not bound what the object may
 * contain. The validated payload is passed on unchanged, so optional and
 * unrecognized fields reach the Portal intact.
 */
export interface IDKitResultV4Payload {
  readonly protocol_version: '4.0';
  readonly nonce: string;
  readonly action: string;
  readonly environment: string;
  readonly responses: readonly ProofResponseItem[];
  readonly action_description?: string;
  readonly user_presence_completed?: boolean;
  readonly session_id?: string;
  readonly identity_attested?: boolean;
  readonly integrity_bundle?: unknown;
  readonly [extra: string]: unknown;
}

export class InvalidProofPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProofPayloadError';
  }
}

const NONCE_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_PATTERN = /^[0-9]+$/;
const HEX_FIELD_PATTERN = /^0x[0-9a-fA-F]{1,64}$/;
/**
 * uint256's decimal width. Checked before `BigInt` sees the string, so an
 * unauthenticated payload cannot make the server parse an unbounded number;
 * `nullifierToBytes32` applies the same bound downstream.
 */
const MAX_DECIMAL_NULLIFIER_DIGITS = 78;

/**
 * Reduce a nullifier to one canonical form: its decimal field element.
 *
 * World sends nullifiers as 0x-hex — both in the IDKit payload and in the
 * `/api/v4/verify` response — although `@worldcoin/idkit-core`'s own types
 * annotate the field "(decimal)". Measured against the live staging endpoint
 * on 2026-11-06, not inferred: both carried `0x` + 64 hex characters. The
 * `proof` array really is decimal, so the two encodings genuinely do coexist
 * in one payload and neither pattern alone is right.
 *
 * Both encodings are accepted, and both collapse to decimal before anything
 * stores or compares them. That matters more than which form is chosen: the
 * uniqueness guarantee rests on a UNIQUE (agent_id, nullifier) index, so the
 * same person arriving once as `0x0a…` and once as decimal — or as `0xA…`
 * against `0x a…` — would occupy two rows and review twice. Decimal is the
 * canonical form because BigInt admits no leading-zero or letter-case variants.
 *
 * This widens the accepted encoding, not the accepted values: anything that is
 * not a field element is still rejected.
 *
 * @returns the decimal form, or undefined if `value` is not a field element.
 */
export function normalizeNullifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (DECIMAL_PATTERN.test(value)) {
    if (value.length > MAX_DECIMAL_NULLIFIER_DIGITS) return undefined;
    return BigInt(value).toString(10);
  }
  if (HEX_FIELD_PATTERN.test(value)) return BigInt(value).toString(10);
  return undefined;
}
/** Groth16 proof (4) plus the Merkle root (1); v4 has no separate merkle_root. */
const PROOF_ELEMENTS = 5;

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidProofPayloadError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new InvalidProofPayloadError(`${what}.${key} must be a non-empty string`);
  }
  return value;
}

/**
 * Validate a forwarded IDKit result without interpreting it.
 *
 * Shape only: whether the proof is cryptographically sound is the Developer
 * Portal's judgement, never this server's. The point of validating first is
 * that every field the server later compares — nonce, action, environment,
 * nullifier, signal hash — is known to exist and be well-formed before any of
 * it is trusted or forwarded.
 *
 * Returns the payload itself, not a reconstruction of it. The Portal is given
 * the complete IDKit result, so dropping a field here would change what gets
 * verified.
 *
 * @throws InvalidProofPayloadError when a required field is missing or malformed.
 */
export function parseIDKitResult(payload: unknown): IDKitResultV4Payload {
  const root = asRecord(payload, 'proof');

  if (root['protocol_version'] !== '4.0') {
    // v3 payloads route to a legacy branch at the API; this server only issues
    // v4 requests, so a v3 result did not come from a request of ours.
    throw new InvalidProofPayloadError('proof.protocol_version must be "4.0"');
  }

  const nonce = requireString(root, 'nonce', 'proof');
  if (!NONCE_PATTERN.test(nonce)) {
    throw new InvalidProofPayloadError('proof.nonce must be a 0x-prefixed 32-byte hex string');
  }

  requireString(root, 'action', 'proof');

  // `environment` is non-optional in the SDK's result type, so its absence means
  // a malformed payload rather than a default to assume.
  const environment = requireString(root, 'environment', 'proof');
  if (!ENVIRONMENTS.includes(environment)) {
    throw new InvalidProofPayloadError(
      `proof.environment must be one of: ${ENVIRONMENTS.join(', ')}`,
    );
  }

  const rawResponses = root['responses'];
  if (!Array.isArray(rawResponses) || rawResponses.length === 0) {
    throw new InvalidProofPayloadError('proof.responses must be a non-empty array');
  }

  rawResponses.forEach((item, i) => {
    assertResponseItem(item, `proof.responses[${i}]`);
  });

  // The payload itself is returned, not a copy assembled from the fields checked
  // above. The API wants the complete IDKit result, and World App may add fields
  // this server has never heard of — `integrity_bundle`, `identity_attested`,
  // anything a later version introduces. Rebuilding the object would silently
  // drop them, and some are part of what the Portal verifies.
  return payload as IDKitResultV4Payload;
}

/**
 * Check one response item in place.
 *
 * Returns nothing: the caller keeps the original object, so validation must not
 * be the thing that produces the value passed on.
 */
function assertResponseItem(value: unknown, what: string): void {
  const item = asRecord(value, what);

  requireString(item, 'identifier', what);

  const schemaId = item['issuer_schema_id'];
  if (typeof schemaId !== 'number' || !Number.isInteger(schemaId)) {
    throw new InvalidProofPayloadError(`${what}.issuer_schema_id must be an integer`);
  }

  const nullifier = requireString(item, 'nullifier', what);
  if (normalizeNullifier(nullifier) === undefined) {
    // Decimal or 0x-hex; World uses hex in practice. See normalizeNullifier.
    throw new InvalidProofPayloadError(`${what}.nullifier must be a field element`);
  }

  const proof = item['proof'];
  if (
    !Array.isArray(proof) ||
    proof.length !== PROOF_ELEMENTS ||
    !proof.every((p) => typeof p === 'string' && DECIMAL_PATTERN.test(p))
  ) {
    throw new InvalidProofPayloadError(`${what}.proof must be ${PROOF_ELEMENTS} decimal strings`);
  }

  // Unix seconds, and deliberately not compared against the clock — see the note
  // at the top of this file. It is a bound the RP asked for, not the
  // credential's expiry, and an expired credential cannot produce a valid proof
  // at all. Rejecting on it here would enforce a minimum this server never
  // requested and would turn valid proofs away.
  const expiresAtMin = item['expires_at_min'];
  if (typeof expiresAtMin !== 'number' || !Number.isInteger(expiresAtMin)) {
    throw new InvalidProofPayloadError(`${what}.expires_at_min must be an integer`);
  }

  const signalHash = item['signal_hash'];
  if (signalHash !== undefined && typeof signalHash !== 'string') {
    throw new InvalidProofPayloadError(`${what}.signal_hash must be a string when present`);
  }
}

/** The Proof of Human response item, or undefined if the proof carries none. */
export function findProofOfHuman(result: IDKitResultV4Payload): ProofResponseItem | undefined {
  return result.responses.find(
    (r) =>
      r.identifier === PROOF_OF_HUMAN_IDENTIFIER && r.issuer_schema_id === PROOF_OF_HUMAN_SCHEMA_ID,
  );
}

/**
 * Whether the proof is bound to `reviewer`.
 *
 * Uses the SDK's `hashSignal`, which is keccak256 shifted right 8 bits and
 * decodes a 0x-hex signal to raw bytes first — a plain keccak of the address
 * string yields a different value and would reject every honest proof. Because
 * hex becomes bytes, checksum casing does not matter.
 *
 * An absent `signal_hash` is a failure, not a pass: the SDK omits it when no
 * signal was supplied, which is exactly an unbound proof that anyone could
 * replay for a different wallet.
 */
export function isBoundToReviewer(item: ProofResponseItem, reviewer: string): boolean {
  if (item.signal_hash === undefined) return false;

  const expected = hashSignal(reviewer);
  return item.signal_hash.toLowerCase() === expected.toLowerCase();
}

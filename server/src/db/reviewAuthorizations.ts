import { randomBytes } from 'node:crypto';
import { getAddress } from 'viem';
import type { Hex } from 'viem';
import { nullifierToBytes32 } from '../signing/reviewContent.js';
import type { Db } from './index.js';
import { normalizeNonce } from './worldIdRequests.js';
import { findVerificationByNonce } from './worldIdVerifications.js';

/** A wallet-authorization challenge, and its outcome once spent. */
export interface ReviewAuthorizationRecord {
  readonly nonce: Hex;
  /** The World ID verification this challenge belongs to. */
  readonly verificationNonce: string;
  /** Canonical decimal uint256. */
  readonly agentId: string;
  readonly reviewer: string;
  /** bytes32, converted once at creation. */
  readonly nullifier: Hex;
  readonly value: number;
  readonly valueDecimals: number;
  readonly feedbackHash: Hex;
  readonly reviewType: number;
  readonly receiptId: Hex;
  readonly deadline: number;
  readonly createdAt: number;
  /** Null until a wallet signature spends it. */
  readonly consumedAt: number | null;
  /** The accepted signature; null until spent. */
  readonly signature: Hex | null;
}

/** The fields supplied when a challenge is created. */
export type NewReviewAuthorization = Omit<
  ReviewAuthorizationRecord,
  'nonce' | 'createdAt' | 'consumedAt' | 'signature'
>;

export class InvalidAuthorizationRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAuthorizationRecordError';
  }
}

/** Why a challenge could not be bound to its World ID verification. */
export type AuthorizationBindingFailure =
  | 'unknown_verification'
  | 'agent_mismatch'
  | 'reviewer_mismatch'
  | 'nullifier_mismatch'
  | 'verification_already_authorized';

/**
 * Raised when a challenge's identity fields do not match the verification it
 * claims.
 *
 * The foreign key alone proves only that the verification exists. It says
 * nothing about whether the agent, reviewer and nullifier are that
 * verification's own — and a challenge that disagreed would ask a wallet to
 * authorize a review the proof never covered.
 */
export class AuthorizationBindingError extends Error {
  constructor(readonly reason: AuthorizationBindingFailure) {
    super(`Challenge does not match its World ID verification: ${reason}`);
    this.name = 'AuthorizationBindingError';
  }
}

/**
 * A fresh challenge nonce.
 *
 * 32 bytes from the platform CSPRNG via `node:crypto` — no dependency, and
 * unguessable, which is what stops a caller claiming a challenge it was never
 * issued.
 */
export function generateAuthorizationNonce(): Hex {
  return `0x${randomBytes(32).toString('hex')}`;
}

interface Row {
  nonce: string;
  verification_nonce: string;
  agent_id: string;
  reviewer: string;
  nullifier: string;
  value: number;
  value_decimals: number;
  feedback_hash: string;
  review_type: number;
  receipt_id: string;
  deadline: number;
  created_at: number;
  consumed_at: number | null;
  signature: string | null;
}

function toRecord(row: Row): ReviewAuthorizationRecord {
  return {
    nonce: row.nonce as Hex,
    verificationNonce: row.verification_nonce,
    agentId: row.agent_id,
    reviewer: row.reviewer,
    nullifier: row.nullifier as Hex,
    value: row.value,
    valueDecimals: row.value_decimals,
    feedbackHash: row.feedback_hash as Hex,
    reviewType: row.review_type,
    receiptId: row.receipt_id as Hex,
    deadline: row.deadline,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
    signature: row.signature as Hex | null,
  };
}

/**
 * Record a new challenge, bound to the verification it claims.
 *
 * The lookup, the checks and the insert are one transaction, so a verification
 * cannot be authorized — or disappear — between being validated and being
 * referenced. `.immediate()` for the same reason the consume uses it: this
 * reads before it writes, and a deferred transaction upgrading to a write under
 * contention fails with SQLITE_BUSY rather than waiting.
 *
 * The content is persisted here and never taken from the client again, so what
 * the wallet signs and what the server later verifies are the same bytes.
 *
 * @throws InvalidAuthorizationRecordError when a field is malformed.
 * @throws AuthorizationBindingError when the challenge does not match the
 *         verification it references.
 */
export function createReviewAuthorization(
  db: Db,
  nonce: Hex,
  request: NewReviewAuthorization,
  createdAt: number,
): ReviewAuthorizationRecord {
  const normalized = normalizeNonce(nonce) as Hex;

  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new InvalidAuthorizationRecordError('createdAt must be a non-negative integer');
  }
  if (!Number.isSafeInteger(request.deadline) || request.deadline <= createdAt) {
    throw new InvalidAuthorizationRecordError('deadline must be an integer after createdAt');
  }

  return db
    .transaction((): ReviewAuthorizationRecord => {
      assertMatchesVerification(db, request);

      db.prepare(
        `INSERT INTO review_authorizations
           (nonce, verification_nonce, agent_id, reviewer, nullifier,
            value, value_decimals, feedback_hash, review_type, receipt_id,
            deadline, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        normalized,
        request.verificationNonce,
        request.agentId,
        request.reviewer,
        request.nullifier,
        request.value,
        request.valueDecimals,
        request.feedbackHash,
        request.reviewType,
        request.receiptId,
        request.deadline,
        createdAt,
      );

      return {
        ...request,
        nonce: normalized,
        createdAt,
        consumedAt: null,
        signature: null,
      };
    })
    .immediate();
}

/**
 * Require the challenge's identity fields to be the referenced verification's
 * own.
 *
 * Addresses are compared through `getAddress`, so checksum casing cannot make
 * two spellings of one address look different. The nullifier is compared by
 * converting the verification's stored decimal with the same
 * `nullifierToBytes32` the challenge was built from — the conversion is not
 * repeated here, so the two cannot disagree about what canonical means.
 */
function assertMatchesVerification(db: Db, request: NewReviewAuthorization): void {
  const verification = findVerificationByNonce(db, request.verificationNonce);
  if (verification === undefined) {
    throw new AuthorizationBindingError('unknown_verification');
  }

  if (verification.agentId !== request.agentId) {
    throw new AuthorizationBindingError('agent_mismatch');
  }

  if (getAddress(verification.reviewer) !== getAddress(request.reviewer)) {
    throw new AuthorizationBindingError('reviewer_mismatch');
  }

  if (
    nullifierToBytes32(verification.nullifier).toLowerCase() !== request.nullifier.toLowerCase()
  ) {
    throw new AuthorizationBindingError('nullifier_mismatch');
  }

  if (isVerificationAuthorized(db, request.verificationNonce)) {
    throw new AuthorizationBindingError('verification_already_authorized');
  }
}

/** The challenge issued under `nonce`, or undefined. */
export function findReviewAuthorization(
  db: Db,
  nonce: string,
): ReviewAuthorizationRecord | undefined {
  const row = db
    .prepare(`SELECT * FROM review_authorizations WHERE nonce = ?`)
    .get(normalizeNonce(nonce)) as Row | undefined;

  return row === undefined ? undefined : toRecord(row);
}

/**
 * The conditional consume: spends a challenge only if it is unspent and still
 * within its deadline.
 *
 * Kept as a named constant for readability alongside its sibling below. The
 * concurrency test races `consumeReviewAuthorization` itself in worker threads
 * rather than this string, so the guarantee is measured against the real
 * function — a reproduction of the SQL can agree today and drift tomorrow.
 *
 * Parameters: consumed_at, signature, nonce, now.
 */
export const CONSUME_AUTHORIZATION_SQL = `UPDATE review_authorizations
          SET consumed_at = ?, signature = ?
        WHERE nonce = ?
          AND consumed_at IS NULL
          AND deadline > ?`;

/** Marks the verification authorized, once. Parameters: authorized_at, nonce. */
export const AUTHORIZE_VERIFICATION_SQL = `UPDATE world_id_verifications
          SET authorized_at = ?
        WHERE nonce = ?
          AND authorized_at IS NULL`;

export type ConsumeAuthorizationResult =
  | {
      readonly ok: true;
      readonly authorization: ReviewAuthorizationRecord;
      /** True when this answered a retry of an already-accepted signature. */
      readonly replayed: boolean;
    }
  | { readonly ok: false; readonly reason: ConsumeAuthorizationFailure };

export type ConsumeAuthorizationFailure =
  | 'unknown_challenge'
  | 'expired'
  /** Consumed already, by a different signature. */
  | 'signature_conflict'
  /** Another challenge for the same verification was authorized first. */
  | 'verification_already_authorized';

/** Thrown inside the transaction to roll it back with a classified reason. */
class Rollback extends Error {
  constructor(readonly reason: ConsumeAuthorizationFailure) {
    super(reason);
    this.name = 'Rollback';
  }
}

export interface ConsumeAuthorizationParams {
  readonly nonce: string;
  /** The signature to accept and store. */
  readonly signature: Hex;
  /** Current time, Unix seconds. */
  readonly now: number;
}

/**
 * Spend a challenge and mark its verification authorized, together or not at
 * all.
 *
 * One transaction over two conditional updates. The first refuses a challenge
 * that is already spent or past its deadline; the second refuses a verification
 * that another challenge already authorized. Because both conditions live in
 * their WHERE clauses, concurrent callers are settled by the database: of any
 * number of simultaneous submissions exactly one commits, and a second challenge
 * for the same verification can never succeed even if it was created first.
 *
 * Retrying with the identical signature returns the original result rather than
 * an error, and writes nothing. A user who signed once must not be asked to sign
 * again because a response was lost; a *different* signature on a spent
 * challenge is a conflict, not a retry.
 *
 * Accepting the signature is all this records. It is not a claim that any review
 * was submitted on-chain.
 */
export function consumeReviewAuthorization(
  db: Db,
  params: ConsumeAuthorizationParams,
): ConsumeAuthorizationResult {
  const nonce = normalizeNonce(params.nonce);

  try {
    // `.immediate()`, not the default deferred mode. This transaction reads
    // before it writes, and a deferred transaction that upgrades to a write
    // while another holds the lock fails immediately with SQLITE_BUSY — a
    // busy_timeout cannot rescue a snapshot upgrade. BEGIN IMMEDIATE takes the
    // write lock up front, so a competing caller waits and then observes the
    // committed state, returning a classified failure instead of throwing.
    return db
      .transaction((): ConsumeAuthorizationResult => {
        const existing = findReviewAuthorization(db, nonce);
        if (existing === undefined) throw new Rollback('unknown_challenge');

        // Idempotent retry, decided before anything is written.
        if (existing.consumedAt !== null) {
          return replayOrConflict(existing, params.signature);
        }

        const consumed = db
          .prepare(CONSUME_AUTHORIZATION_SQL)
          .run(params.now, params.signature, nonce, params.now);

        if (consumed.changes !== 1) {
          // Either it expired, or another caller won the race in between.
          const latest = findReviewAuthorization(db, nonce);
          if (latest !== undefined && latest.consumedAt !== null) {
            return replayOrConflict(latest, params.signature);
          }
          throw new Rollback('expired');
        }

        const authorized = db
          .prepare(AUTHORIZE_VERIFICATION_SQL)
          .run(params.now, existing.verificationNonce);
        if (authorized.changes !== 1) {
          // A sibling challenge for this verification already won; rolling back
          // leaves this one unspent rather than silently discarded.
          throw new Rollback('verification_already_authorized');
        }

        return {
          ok: true,
          replayed: false,
          authorization: { ...existing, consumedAt: params.now, signature: params.signature },
        };
      })
      .immediate();
  } catch (err) {
    if (err instanceof Rollback) return { ok: false, reason: err.reason };
    throw err;
  }
}

/** A spent challenge: the same signature replays, a different one conflicts. */
function replayOrConflict(
  existing: ReviewAuthorizationRecord,
  signature: Hex,
): ConsumeAuthorizationResult {
  return existing.signature !== null && existing.signature.toLowerCase() === signature.toLowerCase()
    ? { ok: true, replayed: true, authorization: existing }
    : { ok: false, reason: 'signature_conflict' };
}

/** Whether this verification has already produced an authorization. */
export function isVerificationAuthorized(db: Db, verificationNonce: string): boolean {
  const row = db
    .prepare(`SELECT authorized_at FROM world_id_verifications WHERE nonce = ?`)
    .get(normalizeNonce(verificationNonce)) as { authorized_at: number | null } | undefined;

  return row?.authorized_at != null;
}

/**
 * Delete expired, unconsumed challenges.
 *
 * Not scheduled yet; kept so the table has a defined growth bound once a sweep
 * exists. Spent challenges are retained — they are the replay record.
 *
 * @returns the number of rows removed.
 */
export function pruneExpiredReviewAuthorizations(db: Db, now: number): number {
  return db
    .prepare(`DELETE FROM review_authorizations WHERE deadline <= ? AND consumed_at IS NULL`)
    .run(now).changes;
}

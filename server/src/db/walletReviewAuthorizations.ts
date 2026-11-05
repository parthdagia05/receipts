import { getAddress } from 'viem';
import type { Hex } from 'viem';
import type { Db } from './index.js';
import { normalizeNonce } from './worldIdRequests.js';

/**
 * A wallet-review challenge, and its outcome once spent.
 *
 * Mirrors `ReviewAuthorizationRecord` minus the World ID verification link.
 * `reviewType` is always 2 (a CHECK constraint says so); it is kept on the
 * record so the attest route reads the type from storage like every other path.
 */
export interface WalletReviewAuthorizationRecord {
  readonly nonce: Hex;
  /** Canonical decimal uint256. */
  readonly agentId: string;
  /** EIP-55 form. */
  readonly reviewer: string;
  /** `walletNullifier(reviewer)`. */
  readonly nullifier: Hex;
  readonly value: number;
  readonly valueDecimals: number;
  readonly feedbackHash: Hex;
  readonly reviewType: number;
  readonly receiptId: Hex;
  readonly deadline: number;
  readonly createdAt: number;
  readonly consumedAt: number | null;
  readonly signature: Hex | null;
}

export type NewWalletReviewAuthorization = Omit<
  WalletReviewAuthorizationRecord,
  'nonce' | 'createdAt' | 'consumedAt' | 'signature'
>;

export class InvalidWalletAuthorizationRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletAuthorizationRecordError';
  }
}

/** This wallet already has a spent review for this agent. */
export class WalletAlreadyReviewedError extends Error {
  constructor() {
    super('This wallet has already reviewed this agent');
    this.name = 'WalletAlreadyReviewedError';
  }
}

export type ConsumeWalletAuthorizationFailure =
  | 'unknown_challenge'
  | 'expired'
  /** Spent already, by a different signature. */
  | 'signature_conflict'
  /** Another challenge for this (agent, reviewer) was spent first. */
  | 'wallet_already_reviewed';

export type ConsumeWalletAuthorizationResult =
  | {
      readonly ok: true;
      readonly authorization: WalletReviewAuthorizationRecord;
      /** True when this answered a retry of an already-accepted signature. */
      readonly replayed: boolean;
    }
  | { readonly ok: false; readonly reason: ConsumeWalletAuthorizationFailure };

export interface ConsumeWalletAuthorizationParams {
  readonly nonce: string;
  readonly signature: Hex;
  /** Current time, Unix seconds. */
  readonly now: number;
}

interface Row {
  nonce: string;
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

function toRecord(row: Row): WalletReviewAuthorizationRecord {
  return {
    nonce: row.nonce as Hex,
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

/** `SQLITE_CONSTRAINT_UNIQUE`: the partial index caught a second spend. */
function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

class Rollback extends Error {
  constructor(readonly reason: ConsumeWalletAuthorizationFailure) {
    super(reason);
    this.name = 'Rollback';
  }
}

/** Whether `reviewer` already has a SPENT wallet review for `agentId`. */
export function isWalletReviewed(db: Db, agentId: string, reviewer: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM wallet_review_authorizations
        WHERE agent_id = ? AND reviewer = ? AND consumed_at IS NOT NULL`,
    )
    .get(agentId, getAddress(reviewer));
  return row !== undefined;
}

/**
 * Record a new wallet challenge.
 *
 * Refused when the wallet already has a spent review for the agent, so a
 * reviewer learns that at prepare time rather than after signing. The check and
 * the insert share one `BEGIN IMMEDIATE` transaction; the authoritative guard is
 * still the unique index at consume time.
 *
 * @throws InvalidWalletAuthorizationRecordError when a field is malformed.
 * @throws WalletAlreadyReviewedError when this wallet already reviewed the agent.
 */
export function createWalletReviewAuthorization(
  db: Db,
  nonce: Hex,
  request: NewWalletReviewAuthorization,
  createdAt: number,
): WalletReviewAuthorizationRecord {
  const normalized = normalizeNonce(nonce) as Hex;
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new InvalidWalletAuthorizationRecordError('createdAt must be a non-negative integer');
  }
  if (!Number.isSafeInteger(request.deadline) || request.deadline <= createdAt) {
    throw new InvalidWalletAuthorizationRecordError('deadline must be an integer after createdAt');
  }
  const reviewer = getAddress(request.reviewer);

  return db
    .transaction((): WalletReviewAuthorizationRecord => {
      if (isWalletReviewed(db, request.agentId, reviewer)) {
        throw new WalletAlreadyReviewedError();
      }

      db.prepare(
        `INSERT INTO wallet_review_authorizations
           (nonce, agent_id, reviewer, nullifier, value, value_decimals,
            feedback_hash, review_type, receipt_id, deadline, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        normalized,
        request.agentId,
        reviewer,
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
        reviewer,
        nonce: normalized,
        createdAt,
        consumedAt: null,
        signature: null,
      };
    })
    .immediate();
}

export function findWalletReviewAuthorization(
  db: Db,
  nonce: string,
): WalletReviewAuthorizationRecord | undefined {
  const row = db
    .prepare(`SELECT * FROM wallet_review_authorizations WHERE nonce = ?`)
    .get(normalizeNonce(nonce)) as Row | undefined;
  return row === undefined ? undefined : toRecord(row);
}

/**
 * Spend a wallet challenge, once.
 *
 * Same contract as `consumeReviewAuthorization`: of any number of concurrent
 * submissions exactly one commits; an identical retry gets the original result
 * and writes nothing; a different signature on a spent challenge is a conflict.
 * In addition, a second challenge for a (agent, reviewer) that already has a
 * spent one is `wallet_already_reviewed` — decided under the write lock, with
 * the partial unique index as the backstop.
 *
 * Accepting the signature is all this records; it does not claim a review was
 * submitted on-chain.
 */
export function consumeWalletReviewAuthorization(
  db: Db,
  params: ConsumeWalletAuthorizationParams,
): ConsumeWalletAuthorizationResult {
  const nonce = normalizeNonce(params.nonce);

  try {
    return db
      .transaction((): ConsumeWalletAuthorizationResult => {
        const existing = findWalletReviewAuthorization(db, nonce);
        if (existing === undefined) throw new Rollback('unknown_challenge');

        if (existing.consumedAt !== null) {
          return replayOrConflict(existing, params.signature);
        }
        if (existing.deadline <= params.now) throw new Rollback('expired');

        if (isWalletReviewed(db, existing.agentId, existing.reviewer)) {
          throw new Rollback('wallet_already_reviewed');
        }

        const consumed = db
          .prepare(
            `UPDATE wallet_review_authorizations
                SET consumed_at = ?, signature = ?
              WHERE nonce = ? AND consumed_at IS NULL AND deadline > ?`,
          )
          .run(params.now, params.signature, nonce, params.now);
        if (consumed.changes !== 1) throw new Rollback('expired');

        return {
          ok: true,
          replayed: false,
          authorization: { ...existing, consumedAt: params.now, signature: params.signature },
        };
      })
      .immediate();
  } catch (err) {
    if (err instanceof Rollback) return { ok: false, reason: err.reason };
    if (isUniqueConstraint(err)) return { ok: false, reason: 'wallet_already_reviewed' };
    throw err;
  }
}

function replayOrConflict(
  existing: WalletReviewAuthorizationRecord,
  signature: Hex,
): ConsumeWalletAuthorizationResult {
  return existing.signature !== null && existing.signature.toLowerCase() === signature.toLowerCase()
    ? { ok: true, replayed: true, authorization: existing }
    : { ok: false, reason: 'signature_conflict' };
}

/** Delete expired, unspent wallet challenges. Spent ones are the replay record. */
export function pruneExpiredWalletReviewAuthorizations(db: Db, now: number): number {
  return db
    .prepare(`DELETE FROM wallet_review_authorizations WHERE deadline <= ? AND consumed_at IS NULL`)
    .run(now).changes;
}

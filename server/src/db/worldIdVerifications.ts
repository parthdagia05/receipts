import type { Db } from './index.js';
import {
  consumeWorldIdRequest,
  isUniqueConstraintViolation,
  normalizeNonce,
} from './worldIdRequests.js';
import type { ConsumeFailure } from './worldIdRequests.js';

/** A verified World ID proof, and the facts a wallet authorization needs. */
export interface WorldIdVerificationRecord {
  /** The RP request this proof answered. */
  readonly nonce: string;
  /** Canonical decimal uint256. */
  readonly agentId: string;
  /** Checksummed reviewer address the proof was bound to. */
  readonly reviewer: string;
  /** RP-scoped nullifier, as the API returns it (decimal field element). */
  readonly nullifier: string;
  readonly verifiedAt: number;
}

export interface RecordVerificationParams {
  readonly nonce: string;
  readonly rpId: string;
  readonly action: string;
  readonly agentId: string;
  readonly reviewer: string;
  readonly nullifier: string;
  /** Unix seconds; also the consume timestamp. */
  readonly now: number;
}

export type RecordVerificationResult =
  | { readonly ok: true; readonly verification: WorldIdVerificationRecord }
  | { readonly ok: false; readonly reason: RecordVerificationFailure };

/**
 * `already_reviewed` means this human has already reviewed this agent, the same
 * condition ReviewGateway enforces on-chain. The rest come from the nonce.
 */
export type RecordVerificationFailure = ConsumeFailure | 'already_reviewed';

/** Thrown inside the transaction to roll it back with a classified reason. */
class Rollback extends Error {
  constructor(readonly reason: RecordVerificationFailure) {
    super(reason);
    this.name = 'Rollback';
  }
}

interface Row {
  nonce: string;
  agent_id: string;
  reviewer: string;
  nullifier: string;
  verified_at: number;
}

function toRecord(row: Row): WorldIdVerificationRecord {
  return {
    nonce: row.nonce,
    agentId: row.agent_id,
    reviewer: row.reviewer,
    nullifier: row.nullifier,
    verifiedAt: row.verified_at,
  };
}

/**
 * Spend the RP request and record the verification, together or not at all.
 *
 * One transaction, because the two must agree: a consumed nonce with no
 * verification would strand the user's proof, and a verification without a
 * consumed nonce would let the same request be replayed. If the human has
 * already reviewed this agent, the unique index refuses the insert and the
 * consume rolls back with it.
 *
 * Concurrency is settled by the database, not by checking first: the consume is
 * a single conditional UPDATE, and `(agent_id, nullifier)` is a unique index, so
 * of any number of simultaneous submissions exactly one can succeed.
 */
export function consumeAndRecordVerification(
  db: Db,
  params: RecordVerificationParams,
): RecordVerificationResult {
  const nonce = normalizeNonce(params.nonce);

  try {
    return db.transaction((): RecordVerificationResult => {
      const consumed = consumeWorldIdRequest(db, {
        nonce,
        rpId: params.rpId,
        action: params.action,
        agentId: params.agentId,
        now: params.now,
      });
      if (!consumed.ok) throw new Rollback(consumed.reason);

      try {
        db.prepare(
          `INSERT INTO world_id_verifications (nonce, agent_id, reviewer, nullifier, verified_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(nonce, params.agentId, params.reviewer, params.nullifier, params.now);
      } catch (err) {
        if (isUniqueConstraintViolation(err)) throw new Rollback('already_reviewed');
        throw err;
      }

      return {
        ok: true,
        verification: {
          nonce,
          agentId: params.agentId,
          reviewer: params.reviewer,
          nullifier: params.nullifier,
          verifiedAt: params.now,
        },
      };
    })();
  } catch (err) {
    if (err instanceof Rollback) return { ok: false, reason: err.reason };
    throw err;
  }
}

/** The verification recorded against `nonce`, or undefined. */
export function findVerificationByNonce(
  db: Db,
  nonce: string,
): WorldIdVerificationRecord | undefined {
  const row = db
    .prepare(`SELECT * FROM world_id_verifications WHERE nonce = ?`)
    .get(normalizeNonce(nonce)) as Row | undefined;

  return row === undefined ? undefined : toRecord(row);
}

/** Whether this human has already reviewed this agent. */
export function hasReviewed(db: Db, agentId: string, nullifier: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS hit FROM world_id_verifications WHERE agent_id = ? AND nullifier = ?`)
    .get(agentId, nullifier) as { hit: number } | undefined;

  return row !== undefined;
}

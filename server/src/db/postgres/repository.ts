import type pg from 'pg';
import { getAddress } from 'viem';
import type { Hex } from 'viem';
import type { Repository } from '../repository.js';
// Value imports, not types: the routes branch on `instanceof`, so the
// PostgreSQL path must throw the SAME classes the SQLite path does. A
// look-alike with a matching `.name` would fall through to a 500.
import {
  AuthorizationBindingError,
  InvalidAuthorizationRecordError,
} from '../reviewAuthorizations.js';
import type {
  ConsumeAuthorizationResult,
  ReviewAuthorizationRecord,
} from '../reviewAuthorizations.js';
import type { ReviewContentRecord } from '../reviewContents.js';
import {
  InvalidWalletAuthorizationRecordError,
  WalletAlreadyReviewedError,
} from '../walletReviewAuthorizations.js';
import type {
  ConsumeWalletAuthorizationFailure,
  ConsumeWalletAuthorizationResult,
  WalletReviewAuthorizationRecord,
} from '../walletReviewAuthorizations.js';
import type { ConsumeFailure, WorldIdRequestRecord } from '../worldIdRequests.js';
import type {
  RecordVerificationResult,
  WorldIdVerificationRecord,
} from '../worldIdVerifications.js';
import { nullifierToBytes32 } from '../../signing/reviewContent.js';
import { createPool, isReachable, isUniqueViolation, withTransaction } from './pool.js';
import type { PgPool } from './pool.js';

/**
 * The PostgreSQL implementation.
 *
 * Reproduces the SQLite behaviour exactly, including the failure
 * classifications, because the routes branch on those strings and the HTTP
 * contract is defined by them.
 *
 * The one place the mechanism genuinely differs is authorization consume.
 * SQLite used `BEGIN IMMEDIATE` to take the write lock before deciding;
 * PostgreSQL has no such mode, so the initial read takes `FOR UPDATE`
 * instead. See `consumeReviewAuthorization` for why that is the minimal
 * correct substitution rather than SERIALIZABLE.
 */

/* --- row → record mapping -------------------------------------------------
 * PostgreSQL returns BIGINT as a string, because a 64-bit integer does not
 * fit a JavaScript number. Every timestamp here is unix seconds and every
 * count is small, so Number() is safe — but it must be explicit, or the
 * records would carry strings where the routes expect numbers and the
 * difference would surface as a wrong comparison rather than a type error.
 */
const num = (value: unknown): number => Number(value);
const numOrNull = (value: unknown): number | null => (value === null ? null : Number(value));

interface RequestRow {
  nonce: string;
  rp_id: string;
  action: string;
  agent_id: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

function toRequest(row: RequestRow): WorldIdRequestRecord {
  return {
    nonce: row.nonce,
    rpId: row.rp_id,
    action: row.action,
    agentId: row.agent_id,
    createdAt: num(row.created_at),
    expiresAt: num(row.expires_at),
    consumedAt: numOrNull(row.consumed_at),
  };
}

interface VerificationRow {
  nonce: string;
  agent_id: string;
  reviewer: string;
  nullifier: string;
  verified_at: string;
  authorized_at: string | null;
}

function toVerification(row: VerificationRow): WorldIdVerificationRecord {
  return {
    nonce: row.nonce,
    agentId: row.agent_id,
    reviewer: row.reviewer,
    nullifier: row.nullifier,
    verifiedAt: num(row.verified_at),
  };
}

interface AuthorizationRow {
  nonce: string;
  verification_nonce: string;
  agent_id: string;
  reviewer: string;
  nullifier: string;
  value: string;
  value_decimals: string;
  feedback_hash: string;
  review_type: string;
  receipt_id: string;
  deadline: string;
  created_at: string;
  consumed_at: string | null;
  signature: string | null;
}

function toAuthorization(row: AuthorizationRow): ReviewAuthorizationRecord {
  return {
    nonce: row.nonce as Hex,
    verificationNonce: row.verification_nonce,
    agentId: row.agent_id,
    reviewer: row.reviewer,
    nullifier: row.nullifier as Hex,
    value: num(row.value),
    valueDecimals: num(row.value_decimals),
    feedbackHash: row.feedback_hash as Hex,
    reviewType: num(row.review_type),
    receiptId: row.receipt_id as Hex,
    deadline: num(row.deadline),
    createdAt: num(row.created_at),
    consumedAt: numOrNull(row.consumed_at),
    signature: row.signature as Hex | null,
  };
}

interface WalletAuthorizationRow {
  nonce: string;
  agent_id: string;
  reviewer: string;
  nullifier: string;
  value: string;
  value_decimals: string;
  feedback_hash: string;
  review_type: string;
  receipt_id: string;
  deadline: string;
  created_at: string;
  consumed_at: string | null;
  signature: string | null;
}

function toWalletAuthorization(row: WalletAuthorizationRow): WalletReviewAuthorizationRecord {
  return {
    nonce: row.nonce as Hex,
    agentId: row.agent_id,
    reviewer: row.reviewer,
    nullifier: row.nullifier as Hex,
    value: num(row.value),
    valueDecimals: num(row.value_decimals),
    feedbackHash: row.feedback_hash as Hex,
    reviewType: num(row.review_type),
    receiptId: row.receipt_id as Hex,
    deadline: num(row.deadline),
    createdAt: num(row.created_at),
    consumedAt: numOrNull(row.consumed_at),
    signature: row.signature as Hex | null,
  };
}

/**
 * Serialize work on one (agent, reviewer) pair for the life of a transaction.
 *
 * PostgreSQL has no `BEGIN IMMEDIATE`. Two consumes of DIFFERENT challenges for
 * the same wallet lock different rows, so a row lock alone would let both read
 * "nobody has reviewed yet". The advisory lock makes them queue; the partial
 * unique index remains the backstop if this is ever bypassed.
 */
async function lockWalletPair(
  client: pg.PoolClient,
  agentId: string,
  reviewer: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `wallet-review:${agentId}:${reviewer}`,
  ]);
}

async function walletPairReviewed(
  client: pg.PoolClient,
  agentId: string,
  reviewer: string,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM wallet_review_authorizations
        WHERE agent_id = $1 AND reviewer = $2 AND consumed_at IS NOT NULL
     ) AS exists`,
    [agentId, reviewer],
  );
  return rows[0]?.exists ?? false;
}

class WalletConsumeRollback extends Error {
  constructor(readonly reason: ConsumeWalletAuthorizationFailure) {
    super(reason);
    this.name = 'WalletConsumeRollback';
  }
}

/* --- helpers -------------------------------------------------------------- */

/** Mirrors `normalizeNonce` in the SQLite module: nonces compare lowercase. */
function normalizeNonce(nonce: string): string {
  return nonce.trim().toLowerCase();
}

async function readAuthorization(
  client: pg.PoolClient,
  nonce: string,
  forUpdate: boolean,
): Promise<ReviewAuthorizationRecord | undefined> {
  const { rows } = await client.query<AuthorizationRow>(
    `SELECT * FROM review_authorizations WHERE nonce = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [nonce],
  );
  const row = rows[0];
  return row === undefined ? undefined : toAuthorization(row);
}

/**
 * The replay-or-conflict decision for an already-consumed challenge.
 *
 * Identical signature means the caller retried and gets the original result.
 * A different signature for the same challenge is a conflict, not a retry:
 * two different signatures cannot both be the one that was accepted.
 */
function replayOrConflict(
  existing: ReviewAuthorizationRecord,
  signature: Hex,
): ConsumeAuthorizationResult {
  if (existing.signature !== null && existing.signature.toLowerCase() === signature.toLowerCase()) {
    return { ok: true, replayed: true, authorization: existing };
  }
  return { ok: false, reason: 'signature_conflict' };
}

export interface PostgresRepositoryOptions {
  readonly connectionString: string;
  readonly max?: number;
}

export function createPostgresRepository(
  optionsOrPool: PostgresRepositoryOptions | PgPool,
): Repository & { readonly pool: PgPool } {
  const pool: PgPool =
    'connectionString' in optionsOrPool
      ? createPool({
          connectionString: optionsOrPool.connectionString,
          ...(optionsOrPool.max === undefined ? {} : { max: optionsOrPool.max }),
        })
      : optionsOrPool;

  return {
    pool,

    async isReachable() {
      return isReachable(pool);
    },

    /* --- World ID requests ----------------------------------------------- */

    async recordWorldIdRequest(params) {
      // No ON CONFLICT: a duplicate nonce is a real fault, and the SQLite
      // version throws for the same reason. `isUniqueConstraintViolation`
      // in the route turns it into a 500 rather than a silent success.
      await pool.query(
        `INSERT INTO world_id_requests (nonce, rp_id, action, agent_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          normalizeNonce(params.nonce),
          params.rpId,
          params.action,
          params.agentId,
          params.createdAt,
          params.expiresAt,
        ],
      );
    },

    async findWorldIdRequest(nonce) {
      const { rows } = await pool.query<RequestRow>(
        'SELECT * FROM world_id_requests WHERE nonce = $1',
        [normalizeNonce(nonce)],
      );
      const row = rows[0];
      return row === undefined ? undefined : toRequest(row);
    },

    async checkWorldIdRequestUsable(params) {
      const { rows } = await pool.query<RequestRow & { already_reviewed: boolean }>(
        `SELECT r.*,
                EXISTS (
                  SELECT 1 FROM world_id_verifications v
                  WHERE v.agent_id = $2 AND v.nonce <> r.nonce
                ) AS already_reviewed
           FROM world_id_requests r
          WHERE r.nonce = $1`,
        [normalizeNonce(params.nonce), params.agentId],
      );
      const row = rows[0];
      if (row === undefined) return 'unknown_nonce';

      const record = toRequest(row);
      if (record.consumedAt !== null) return 'already_consumed';
      // Exclusive at the boundary, matching the SQLite comment: at
      // `expires_at` the request is already expired.
      if (record.expiresAt <= params.now) return 'expired';
      if (
        record.rpId !== params.rpId ||
        record.action !== params.action ||
        record.agentId !== params.agentId
      ) {
        return 'context_mismatch';
      }
      return undefined;
    },

    /* --- Verifications ---------------------------------------------------- */

    async consumeAndRecordVerification(params): Promise<RecordVerificationResult> {
      const nonce = normalizeNonce(params.nonce);

      try {
        return await withTransaction(pool, async (client) => {
          // Lock the request row first. Without FOR UPDATE two callers can
          // both read `consumed_at IS NULL` and both proceed; the conditional
          // UPDATE below would still let only one win, but the second would
          // then report `expired` rather than `already_consumed`, which is a
          // different HTTP status.
          const { rows } = await client.query<RequestRow>(
            'SELECT * FROM world_id_requests WHERE nonce = $1 FOR UPDATE',
            [nonce],
          );
          const row = rows[0];
          if (row === undefined) return { ok: false as const, reason: 'unknown_nonce' as const };

          const request = toRequest(row);
          if (request.consumedAt !== null) {
            return { ok: false as const, reason: 'already_consumed' as const };
          }
          if (request.expiresAt <= params.now) {
            return { ok: false as const, reason: 'expired' as const };
          }
          if (
            request.rpId !== params.rpId ||
            request.action !== params.action ||
            request.agentId !== params.agentId
          ) {
            return { ok: false as const, reason: 'context_mismatch' as const };
          }

          // Conditional, and the rowCount is checked. The FOR UPDATE above
          // makes the read-then-decide safe, but the guarantee must not rest
          // on the lock alone: an unconditional UPDATE would let two callers
          // that both read `consumed_at IS NULL` each mark the request spent
          // and each insert a verification. This mirrors the SQLite modules,
          // where the note at worldIdRequests.ts:194 is explicit that safety
          // comes from the statement rather than from the driver.
          const spent = await client.query(
            'UPDATE world_id_requests SET consumed_at = $1 WHERE nonce = $2 AND consumed_at IS NULL',
            [params.now, nonce],
          );
          if (spent.rowCount !== 1) {
            return { ok: false as const, reason: 'already_consumed' as const };
          }

          // UNIQUE (agent_id, nullifier) is the one-human-one-review rule.
          // The insert is what enforces it; a check-then-insert would race.
          try {
            await client.query(
              `INSERT INTO world_id_verifications
                 (nonce, agent_id, reviewer, nullifier, verified_at)
               VALUES ($1, $2, $3, $4, $5)`,
              [nonce, params.agentId, params.reviewer, params.nullifier, params.now],
            );
          } catch (error) {
            if (isUniqueViolation(error)) {
              // Rolls the whole transaction back, so the request stays
              // unspent rather than being burned on a rejected proof.
              throw new AlreadyReviewed();
            }
            throw error;
          }

          return {
            ok: true as const,
            verification: {
              nonce,
              agentId: params.agentId,
              reviewer: params.reviewer,
              nullifier: params.nullifier,
              verifiedAt: params.now,
            },
          };
        });
      } catch (error) {
        if (error instanceof AlreadyReviewed) {
          return { ok: false, reason: 'already_reviewed' };
        }
        throw error;
      }
    },

    async findVerificationByNonce(nonce) {
      const { rows } = await pool.query<VerificationRow>(
        'SELECT * FROM world_id_verifications WHERE nonce = $1',
        [normalizeNonce(nonce)],
      );
      const row = rows[0];
      return row === undefined ? undefined : toVerification(row);
    },

    /* --- Authorizations ---------------------------------------------------- */

    async createReviewAuthorization(nonce, params, createdAt) {
      // Validated before any database work, exactly as the SQLite module
      // does, so a malformed record fails identically on both backends.
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new InvalidAuthorizationRecordError('createdAt must be a non-negative integer');
      }
      if (!Number.isSafeInteger(params.deadline) || params.deadline <= createdAt) {
        throw new InvalidAuthorizationRecordError('deadline must be an integer after createdAt');
      }

      await withTransaction(pool, async (client) => {
        // The lookup, the checks and the insert are one transaction, so a
        // verification cannot be authorized -- or disappear -- between being
        // validated and being referenced. FOR UPDATE is the PostgreSQL stand-in
        // for the SQLite version's BEGIN IMMEDIATE.
        const { rows } = await client.query<VerificationRow>(
          'SELECT * FROM world_id_verifications WHERE nonce = $1 FOR UPDATE',
          [params.verificationNonce],
        );
        const row = rows[0];
        if (row === undefined) throw new AuthorizationBindingError('unknown_verification');

        // Every identity field on the challenge must be the verification's
        // own. Reproduces `assertMatchesVerification` exactly, including the
        // failure strings, because the route branches on them.
        const verification = toVerification(row);
        if (verification.agentId !== params.agentId) {
          throw new AuthorizationBindingError('agent_mismatch');
        }
        if (getAddress(verification.reviewer) !== getAddress(params.reviewer)) {
          throw new AuthorizationBindingError('reviewer_mismatch');
        }
        if (
          nullifierToBytes32(verification.nullifier).toLowerCase() !==
          params.nullifier.toLowerCase()
        ) {
          throw new AuthorizationBindingError('nullifier_mismatch');
        }
        // Note this is `authorized_at`, not "has any challenge": two
        // challenges may exist for one verification, and only one may be
        // CONSUMED. The losing sibling is rolled back at consume time.
        if (row.authorized_at !== null) {
          throw new AuthorizationBindingError('verification_already_authorized');
        }

        await client.query(
          `INSERT INTO review_authorizations
             (nonce, verification_nonce, agent_id, reviewer, nullifier, value,
              value_decimals, feedback_hash, review_type, receipt_id, deadline, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            normalizeNonce(nonce),
            params.verificationNonce,
            params.agentId,
            params.reviewer,
            params.nullifier,
            params.value,
            params.valueDecimals,
            params.feedbackHash,
            params.reviewType,
            params.receiptId,
            params.deadline,
            createdAt,
          ],
        );
      });
    },

    async findReviewAuthorization(nonce) {
      const { rows } = await pool.query<AuthorizationRow>(
        'SELECT * FROM review_authorizations WHERE nonce = $1',
        [normalizeNonce(nonce)],
      );
      const row = rows[0];
      return row === undefined ? undefined : toAuthorization(row);
    },

    /**
     * Consume a challenge. The one place the locking strategy differs.
     *
     * SQLite used `BEGIN IMMEDIATE` to take the write lock before deciding,
     * because a deferred transaction that upgrades to a write while another
     * holds the lock fails with SQLITE_BUSY and a busy_timeout cannot rescue
     * it. PostgreSQL has no equivalent mode. The options were:
     *
     *   READ COMMITTED  no protection for read-then-write -- reintroduces
     *                   exactly the race BEGIN IMMEDIATE existed to prevent
     *   SERIALIZABLE    correct, but aborts with 40001 and the caller must
     *                   retry; there is no retry logic, so a classified
     *                   failure would become an exception
     *   FOR UPDATE      takes the row lock on the initial read
     *
     * `FOR UPDATE` is chosen: it maps directly onto "take the write lock
     * before deciding", which is what the original code means, and needs no
     * new retry machinery. A competing caller blocks on the lock, then
     * observes committed state and returns a classified failure -- the same
     * observable behaviour as SQLite.
     */
    async consumeReviewAuthorization(params): Promise<ConsumeAuthorizationResult> {
      const nonce = normalizeNonce(params.nonce);

      try {
        return await withTransaction(pool, async (client) => {
          const existing = await readAuthorization(client, nonce, true);
          if (existing === undefined) throw new ConsumeRollback('unknown_challenge');

          // Idempotent retry, decided before anything is written.
          if (existing.consumedAt !== null) {
            return replayOrConflict(existing, params.signature);
          }

          const consumed = await client.query(
            `UPDATE review_authorizations
                SET consumed_at = $1, signature = $2
              WHERE nonce = $3 AND consumed_at IS NULL AND deadline > $4`,
            [params.now, params.signature, nonce, params.now],
          );

          if (consumed.rowCount !== 1) {
            // Holding the row lock, the only remaining cause is the deadline.
            throw new ConsumeRollback('expired');
          }

          const authorized = await client.query(
            `UPDATE world_id_verifications
                SET authorized_at = $1
              WHERE nonce = $2 AND authorized_at IS NULL`,
            [params.now, existing.verificationNonce],
          );
          if (authorized.rowCount !== 1) {
            // A sibling challenge for this verification already won. Rolling
            // back leaves this one unspent rather than silently discarded.
            throw new ConsumeRollback('verification_already_authorized');
          }

          return {
            ok: true as const,
            replayed: false,
            authorization: {
              ...existing,
              consumedAt: params.now,
              signature: params.signature,
            },
          };
        });
      } catch (error) {
        if (error instanceof ConsumeRollback) {
          return { ok: false, reason: error.reason };
        }
        throw error;
      }
    },

    async isVerificationAuthorized(verificationNonce) {
      const { rows } = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM world_id_verifications
            WHERE nonce = $1 AND authorized_at IS NOT NULL
         ) AS exists`,
        [verificationNonce],
      );
      return rows[0]?.exists ?? false;
    },

    /* --- Wallet-verified authorizations ------------------------------------ */

    async createWalletReviewAuthorization(nonce, params, createdAt) {
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new InvalidWalletAuthorizationRecordError('createdAt must be a non-negative integer');
      }
      if (!Number.isSafeInteger(params.deadline) || params.deadline <= createdAt) {
        throw new InvalidWalletAuthorizationRecordError(
          'deadline must be an integer after createdAt',
        );
      }
      const reviewer = getAddress(params.reviewer);

      await withTransaction(pool, async (client) => {
        await lockWalletPair(client, params.agentId, reviewer);
        if (await walletPairReviewed(client, params.agentId, reviewer)) {
          throw new WalletAlreadyReviewedError();
        }
        await client.query(
          `INSERT INTO wallet_review_authorizations
             (nonce, agent_id, reviewer, nullifier, value, value_decimals,
              feedback_hash, review_type, receipt_id, deadline, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            normalizeNonce(nonce),
            params.agentId,
            reviewer,
            params.nullifier,
            params.value,
            params.valueDecimals,
            params.feedbackHash,
            params.reviewType,
            params.receiptId,
            params.deadline,
            createdAt,
          ],
        );
      });
    },

    async findWalletReviewAuthorization(nonce) {
      const { rows } = await pool.query<WalletAuthorizationRow>(
        'SELECT * FROM wallet_review_authorizations WHERE nonce = $1',
        [normalizeNonce(nonce)],
      );
      const row = rows[0];
      return row === undefined ? undefined : toWalletAuthorization(row);
    },

    async consumeWalletReviewAuthorization(params): Promise<ConsumeWalletAuthorizationResult> {
      const nonce = normalizeNonce(params.nonce);

      // The pair is only known after reading the challenge, so read it once
      // without a lock to learn the pair, take the pair lock, then re-read the
      // row FOR UPDATE and decide on that.
      const peek = await pool.query<WalletAuthorizationRow>(
        'SELECT * FROM wallet_review_authorizations WHERE nonce = $1',
        [nonce],
      );
      const peeked = peek.rows[0];
      if (peeked === undefined) return { ok: false, reason: 'unknown_challenge' };

      try {
        return await withTransaction(pool, async (client) => {
          await lockWalletPair(client, peeked.agent_id, peeked.reviewer);

          const { rows } = await client.query<WalletAuthorizationRow>(
            'SELECT * FROM wallet_review_authorizations WHERE nonce = $1 FOR UPDATE',
            [nonce],
          );
          const row = rows[0];
          if (row === undefined) throw new WalletConsumeRollback('unknown_challenge');
          const existing = toWalletAuthorization(row);

          if (existing.consumedAt !== null) {
            return existing.signature !== null &&
              existing.signature.toLowerCase() === params.signature.toLowerCase()
              ? { ok: true as const, replayed: true, authorization: existing }
              : { ok: false as const, reason: 'signature_conflict' as const };
          }
          if (existing.deadline <= params.now) throw new WalletConsumeRollback('expired');

          if (await walletPairReviewed(client, existing.agentId, existing.reviewer)) {
            throw new WalletConsumeRollback('wallet_already_reviewed');
          }

          const consumed = await client.query(
            `UPDATE wallet_review_authorizations
                SET consumed_at = $1, signature = $2
              WHERE nonce = $3 AND consumed_at IS NULL AND deadline > $4`,
            [params.now, params.signature, nonce, params.now],
          );
          if (consumed.rowCount !== 1) throw new WalletConsumeRollback('expired');

          return {
            ok: true as const,
            replayed: false,
            authorization: { ...existing, consumedAt: params.now, signature: params.signature },
          };
        });
      } catch (error) {
        if (error instanceof WalletConsumeRollback) return { ok: false, reason: error.reason };
        if (isUniqueViolation(error)) return { ok: false, reason: 'wallet_already_reviewed' };
        throw error;
      }
    },

    async isWalletReviewed(agentId, reviewer) {
      const { rows } = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM wallet_review_authorizations
            WHERE agent_id = $1 AND reviewer = $2 AND consumed_at IS NOT NULL
         ) AS exists`,
        [agentId, getAddress(reviewer)],
      );
      return rows[0]?.exists ?? false;
    },

    /* --- Review content ----------------------------------------------------- */

    async putReviewContent(params) {
      // The key is derived here, never accepted, exactly as the SQLite
      // version does: the row's address must be a hash of its own bytes.
      const { keccak256 } = await import('viem');
      const feedbackHash = keccak256(params.content);
      await pool.query(
        `INSERT INTO review_contents (feedback_hash, content, created_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (feedback_hash) DO NOTHING`,
        [feedbackHash, Buffer.from(params.content), params.createdAt],
      );
    },

    async findReviewContent(feedbackHash): Promise<ReviewContentRecord | null> {
      const { rows } = await pool.query<{
        feedback_hash: string;
        content: Buffer;
        created_at: string;
      }>('SELECT * FROM review_contents WHERE feedback_hash = $1', [feedbackHash.toLowerCase()]);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        feedbackHash: row.feedback_hash as Hex,
        content: new Uint8Array(row.content),
        createdAt: num(row.created_at),
      };
    },

    async close() {
      await pool.end();
    },
  };
}

/* --- internal control-flow signals ---------------------------------------
 * Thrown to roll a transaction back with a classification attached. They
 * never escape the methods above.
 */

class ConsumeRollback extends Error {
  readonly reason: Extract<ConsumeAuthorizationResult, { ok: false }>['reason'];
  constructor(reason: ConsumeRollback['reason']) {
    super(reason);
    this.name = 'ConsumeRollback';
    this.reason = reason;
  }
}

class AlreadyReviewed extends Error {
  constructor() {
    super('already_reviewed');
    this.name = 'AlreadyReviewed';
  }
}

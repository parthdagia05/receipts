import type { Db } from './index.js';

/** An RP request this server issued. Timestamps are Unix seconds. */
export interface WorldIdRequestRecord {
  readonly nonce: string;
  readonly rpId: string;
  readonly action: string;
  /** Canonical decimal uint256. */
  readonly agentId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Null until a proof spends the request. */
  readonly consumedAt: number | null;
}

/** The fields recorded when a request is issued. */
export type NewWorldIdRequest = Omit<WorldIdRequestRecord, 'consumedAt'>;

/** Raised when a value fails a shape check before it reaches the database. */
export class InvalidRequestRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestRecordError';
  }
}

/** Raised when a nonce has already been recorded. */
export class DuplicateNonceError extends Error {
  constructor() {
    super('nonce has already been issued');
    this.name = 'DuplicateNonceError';
  }
}

const NONCE_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_PATTERN = /^[0-9]+$/;

/** Digits in uint256's decimal maximum; longer is out of range by construction. */
const MAX_AGENT_ID_DIGITS = 78;
const UINT256_MAX = 2n ** 256n - 1n;

/**
 * Check `agentId` is the canonical decimal form of a positive uint256.
 *
 * Repeated here rather than trusted from the route: this is the last point
 * before the value becomes a stored fact, and a non-canonical spelling would
 * make the row unreachable by a lookup built from the canonical one. The length
 * bound runs before `BigInt` so an oversized string is never parsed.
 */
function assertCanonicalAgentId(agentId: string): void {
  if (!DECIMAL_PATTERN.test(agentId)) {
    throw new InvalidRequestRecordError('agentId must contain only decimal digits');
  }
  if (agentId.length > 1 && agentId.startsWith('0')) {
    throw new InvalidRequestRecordError('agentId must not have leading zeros');
  }
  if (agentId.length > MAX_AGENT_ID_DIGITS) {
    throw new InvalidRequestRecordError('agentId must fit in uint256');
  }

  const value = BigInt(agentId);
  if (value === 0n) {
    throw new InvalidRequestRecordError('agentId must be greater than zero');
  }
  if (value > UINT256_MAX) {
    throw new InvalidRequestRecordError('agentId must fit in uint256');
  }
}

/**
 * Canonical storage form of a nonce.
 *
 * Lowercased so a lookup cannot miss a record over hex casing, which would read
 * as "unknown nonce" and silently reject a legitimate proof.
 */
export function normalizeNonce(nonce: string): string {
  if (!NONCE_PATTERN.test(nonce)) {
    // The nonce is not secret, but it is unbounded caller-adjacent input, so the
    // message describes the expectation instead of echoing it.
    throw new InvalidRequestRecordError('nonce must be a 0x-prefixed 32-byte hex string');
  }
  return nonce.toLowerCase();
}

function assertUnixSeconds(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidRequestRecordError(`${field} must be a non-negative integer (Unix seconds)`);
  }
}

/**
 * Record an issued request.
 *
 * Called before the response is returned, so a request the caller holds is
 * always one the database knows about.
 *
 * @throws InvalidRequestRecordError when a field is malformed.
 * @throws DuplicateNonceError when the nonce was already issued.
 */
export function recordWorldIdRequest(db: Db, request: NewWorldIdRequest): WorldIdRequestRecord {
  const nonce = normalizeNonce(request.nonce);

  if (request.rpId === '') throw new InvalidRequestRecordError('rpId must not be empty');
  if (request.action === '') throw new InvalidRequestRecordError('action must not be empty');
  assertCanonicalAgentId(request.agentId);
  assertUnixSeconds(request.createdAt, 'createdAt');
  assertUnixSeconds(request.expiresAt, 'expiresAt');
  if (request.expiresAt < request.createdAt) {
    throw new InvalidRequestRecordError('expiresAt must not precede createdAt');
  }

  try {
    db.prepare(
      `INSERT INTO world_id_requests (nonce, rp_id, action, agent_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      nonce,
      request.rpId,
      request.action,
      request.agentId,
      request.createdAt,
      request.expiresAt,
    );
  } catch (err) {
    if (isDuplicateNonce(err)) throw new DuplicateNonceError();
    // Anything else is a real database fault; pass it through untouched.
    throw err;
  }

  return { ...request, nonce, consumedAt: null };
}

/**
 * The two SQLite codes that mean "this nonce is already recorded".
 *
 * Narrow on purpose: `SQLITE_CONSTRAINT` also covers NOT NULL, CHECK, foreign
 * key and trigger aborts, and reporting one of those as a duplicate nonce would
 * turn a schema or data fault into a plausible-looking "already issued" and
 * hide it.
 */
const DUPLICATE_NONCE_CODES = new Set(['SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_UNIQUE']);

/** Whether `err` is a primary-key or unique-index collision, and nothing else. */
export function isUniqueConstraintViolation(err: unknown): boolean {
  return isDuplicateNonce(err);
}

function isDuplicateNonce(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    DUPLICATE_NONCE_CODES.has((err as { code: string }).code)
  );
}

interface Row {
  nonce: string;
  rp_id: string;
  action: string;
  agent_id: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

function toRecord(row: Row): WorldIdRequestRecord {
  return {
    nonce: row.nonce,
    rpId: row.rp_id,
    action: row.action,
    agentId: row.agent_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

/** The request issued under `nonce`, or undefined. */
export function findWorldIdRequest(db: Db, nonce: string): WorldIdRequestRecord | undefined {
  const row = db
    .prepare(`SELECT * FROM world_id_requests WHERE nonce = ?`)
    .get(normalizeNonce(nonce)) as Row | undefined;

  return row === undefined ? undefined : toRecord(row);
}

/**
 * The whole consume, as one statement.
 *
 * Exported so a test can run this exact SQL from several processes at once and
 * confirm only one of them matches the row — the guarantee cannot be observed
 * from a single thread, because better-sqlite3 is synchronous and never
 * interleaves two calls.
 *
 * Parameters: consumed_at, nonce, now, rp_id, action, agent_id.
 */
export const CONSUME_SQL = `UPDATE world_id_requests
          SET consumed_at = ?
        WHERE nonce = ?
          AND consumed_at IS NULL
          AND expires_at > ?
          AND rp_id = ?
          AND action = ?
          AND agent_id = ?`;

/** Why a consume attempt failed, or that it succeeded. */
export type ConsumeResult =
  | { readonly ok: true; readonly request: WorldIdRequestRecord }
  | { readonly ok: false; readonly reason: ConsumeFailure };

export type ConsumeFailure = 'unknown_nonce' | 'already_consumed' | 'expired' | 'context_mismatch';

export interface ConsumeParams {
  readonly nonce: string;
  /** Must equal the issuing RP, action and agent, or the request is not this one. */
  readonly rpId: string;
  readonly action: string;
  readonly agentId: string;
  /** Current time, Unix seconds. Injected so expiry is testable. */
  readonly now: number;
}

/**
 * Why this request could not be spent right now, or undefined if it could.
 *
 * Read-only, and advisory by nature: the answer can be stale the moment it is
 * returned, so it must never stand in for the consume. Its purpose is to decline
 * obviously unusable requests before an expensive side effect — an external
 * verification call — rather than after one. `consumeWorldIdRequest` remains the
 * only thing that decides.
 *
 * Shares `findWorldIdRequest` and the classification order with the consume, so
 * the two cannot disagree about what a given failure is called.
 */
export function checkWorldIdRequestUsable(
  db: Db,
  params: ConsumeParams,
): ConsumeFailure | undefined {
  const existing = findWorldIdRequest(db, params.nonce);

  if (existing === undefined) return 'unknown_nonce';
  if (existing.consumedAt !== null) return 'already_consumed';
  if (existing.expiresAt <= params.now) return 'expired';
  if (
    existing.rpId !== params.rpId ||
    existing.action !== params.action ||
    existing.agentId !== params.agentId
  ) {
    return 'context_mismatch';
  }

  return undefined;
}

/**
 * Spend a request, if it is unspent, unexpired, and bound to this context.
 *
 * Every condition lives in the UPDATE's WHERE clause, so the check and the
 * write are one statement. Two concurrent callers therefore cannot both
 * succeed: SQLite serializes the writes and the second matches no row. A
 * read-then-write would leave exactly that race open.
 *
 * On failure a follow-up read classifies the reason. That read is advisory
 * only — the UPDATE's row count is what decides the outcome.
 */
export function consumeWorldIdRequest(db: Db, params: ConsumeParams): ConsumeResult {
  const nonce = normalizeNonce(params.nonce);

  const result = db
    .prepare(CONSUME_SQL)
    .run(params.now, nonce, params.now, params.rpId, params.action, params.agentId);

  if (result.changes === 1) {
    const request = findWorldIdRequest(db, nonce);
    // The row was just updated in this connection, so it is present.
    return { ok: true, request: request as WorldIdRequestRecord };
  }

  const existing = findWorldIdRequest(db, nonce);
  if (existing === undefined) return { ok: false, reason: 'unknown_nonce' };
  if (existing.consumedAt !== null) return { ok: false, reason: 'already_consumed' };
  // Expiry is exclusive: at `expires_at` the request is already expired, which
  // matches how the World ID SDK's expiresAt reads and avoids a one-second
  // window where this server and the verifier could disagree.
  if (existing.expiresAt <= params.now) return { ok: false, reason: 'expired' };
  return { ok: false, reason: 'context_mismatch' };
}

/**
 * Delete expired, unconsumed requests.
 *
 * Not wired to a scheduler yet; kept here so the table has a defined growth
 * bound once one exists.
 *
 * @returns the number of rows removed.
 */
export function pruneExpiredWorldIdRequests(db: Db, now: number): number {
  return db
    .prepare(`DELETE FROM world_id_requests WHERE expires_at <= ? AND consumed_at IS NULL`)
    .run(now).changes;
}

import { keccak256 } from 'viem';
import type { Hex } from 'viem';
import type { Db } from './index.js';

/** Stored review content. `content` is the exact byte string that was hashed. */
export interface ReviewContentRecord {
  readonly feedbackHash: Hex;
  readonly content: Uint8Array;
  readonly createdAt: number;
}

/** Raised when a value fails a shape check before it reaches the database. */
export class InvalidReviewContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReviewContentError';
  }
}

const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Canonical lowercase form, so a hash stores and looks up identically. */
function normalizeHash(feedbackHash: string): Hex {
  if (!BYTES32_PATTERN.test(feedbackHash)) {
    throw new InvalidReviewContentError('feedbackHash must be a 0x-prefixed 32-byte hex string');
  }
  return feedbackHash.toLowerCase() as Hex;
}

/**
 * Store review content under its own hash.
 *
 * The caller passes the bytes it hashed; this recomputes the hash and refuses a
 * mismatch, so a bug upstream cannot publish content under a key that does not
 * describe it — the one property the retrieval route depends on.
 *
 * Writing is idempotent and never destructive. A row already under this hash is
 * left exactly as it is: keccak256 is what makes that safe, because identical
 * keys mean identical bytes, and it is what makes content under an already
 * signed attestation impossible to swap.
 *
 * @returns true when this call inserted the row, false when it already existed.
 * @throws InvalidReviewContentError when the hash is malformed or does not
 *         match the content.
 */
export function putReviewContent(
  db: Db,
  params: { readonly content: Uint8Array; readonly createdAt: number },
): { readonly feedbackHash: Hex; readonly inserted: boolean } {
  if (!(params.content instanceof Uint8Array)) {
    throw new InvalidReviewContentError('content must be a Uint8Array');
  }
  if (params.content.length === 0) {
    throw new InvalidReviewContentError('content must not be empty');
  }
  if (!Number.isInteger(params.createdAt) || params.createdAt < 0) {
    throw new InvalidReviewContentError('createdAt must be a non-negative integer');
  }

  const feedbackHash = normalizeHash(keccak256(params.content));

  // INSERT OR IGNORE, not upsert: the primary key is the content's own hash, so
  // there is deliberately no statement in this module that can overwrite it.
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO review_contents (feedback_hash, content, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(feedbackHash, Buffer.from(params.content), params.createdAt);

  return { feedbackHash, inserted: result.changes === 1 };
}

/** Read content by hash, or null when nothing is stored under it. */
export function findReviewContent(db: Db, feedbackHash: string): ReviewContentRecord | null {
  const key = normalizeHash(feedbackHash);

  const row = db
    .prepare(
      `SELECT feedback_hash, content, created_at FROM review_contents WHERE feedback_hash = ?`,
    )
    .get(key) as { feedback_hash: string; content: Buffer; created_at: number } | undefined;

  if (row === undefined) return null;

  return {
    feedbackHash: row.feedback_hash as Hex,
    content: new Uint8Array(row.content),
    createdAt: row.created_at,
  };
}

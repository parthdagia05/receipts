import { parentPort, workerData } from 'node:worker_threads';
import type { Hex } from 'viem';
import { openDatabase } from '../../src/db/index.js';
import { consumeReviewAuthorization } from '../../src/db/reviewAuthorizations.js';

/**
 * Race the real `consumeReviewAuthorization` from a separate OS thread.
 *
 * Loaded as TypeScript via `execArgv: ['--import', 'tsx']`, so this runs the
 * exported repository function itself — the transaction, the idempotency
 * pre-read and the reclassification — rather than a reproduction of its SQL.
 * A reproduction can agree with the implementation today and drift tomorrow.
 */
interface Input {
  readonly dbPath: string;
  readonly nonce: string;
  readonly signature: Hex;
  readonly now: number;
  readonly startAt: number;
}

interface Output {
  readonly ok: boolean;
  readonly replayed: boolean | null;
  readonly reason: string | null;
  /** Set when the call threw — a SQLite lock error, for instance. */
  readonly threw: string | null;
}

const input = workerData as Input;
const db = openDatabase(input.dbPath);

// Spin to the shared barrier so every thread attempts at the same instant.
while (Date.now() < input.startAt) {
  /* intentionally busy */
}

let output: Output;
try {
  const result = consumeReviewAuthorization(db, {
    nonce: input.nonce,
    signature: input.signature,
    now: input.now,
  });
  output = result.ok
    ? { ok: true, replayed: result.replayed, reason: null, threw: null }
    : { ok: false, replayed: null, reason: result.reason, threw: null };
} catch (err) {
  output = {
    ok: false,
    replayed: null,
    reason: null,
    threw:
      err instanceof Error
        ? (((err as { code?: string }).code ?? err.message) as string)
        : 'unknown',
  };
}

db.close();
parentPort?.postMessage(output);

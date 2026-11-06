import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../../src/db/index.js';
import { consumeAndRecordVerification } from '../../src/db/worldIdVerifications.js';

/**
 * Race the real `consumeAndRecordVerification` from a separate OS thread.
 *
 * Companion to the authorization worker: confirms the Chunk 4A transaction also
 * survives contention without throwing, now that connections carry a
 * busy_timeout.
 */
interface Input {
  readonly dbPath: string;
  readonly nonce: string;
  readonly rpId: string;
  readonly action: string;
  readonly agentId: string;
  readonly reviewer: string;
  readonly nullifier: string;
  readonly now: number;
  readonly startAt: number;
}

const input = workerData as Input;
const db = openDatabase(input.dbPath);

while (Date.now() < input.startAt) {
  /* intentionally busy */
}

let output: { ok: boolean; reason: string | null; threw: string | null };
try {
  const result = consumeAndRecordVerification(db, {
    nonce: input.nonce,
    rpId: input.rpId,
    action: input.action,
    agentId: input.agentId,
    reviewer: input.reviewer,
    nullifier: input.nullifier,
    now: input.now,
  });
  output = result.ok
    ? { ok: true, reason: null, threw: null }
    : { ok: false, reason: result.reason, threw: null };
} catch (err) {
  output = {
    ok: false,
    reason: null,
    threw: err instanceof Error ? ((err as { code?: string }).code ?? err.message) : 'unknown',
  };
}

db.close();
parentPort?.postMessage(output);

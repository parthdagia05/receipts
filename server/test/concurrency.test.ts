import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  CONSUME_SQL,
  findWorldIdRequest,
  recordWorldIdRequest,
} from '../src/db/worldIdRequests.js';
import { consumeAndRecordVerification } from '../src/db/worldIdVerifications.js';
import { createReviewAuthorization } from '../src/db/reviewAuthorizations.js';
import { ZERO_BYTES32, nullifierToBytes32 } from '../src/signing/reviewContent.js';
import type { Hex } from 'viem';
import { VALID_ENV } from './fixtures.js';

const NONCE = `0x${'ab'.repeat(32)}`;
const NOW = 1_793_740_542;
const WORKERS = 8;
const REVIEWER = '0xAbAbaBAbABabAbabAbaBABaBabababaBaBAbAbAb';
const NULLIFIER_DECIMAL = '7';
const SIGNATURE = `0x${'cd'.repeat(65)}`;

/** Headroom for every worker to boot and open the database before the barrier. */
const BARRIER_MS = 400;

/**
 * Run the production consume statement from a separate thread.
 *
 * The SQL is passed in rather than restated, so this races the real statement.
 * Plain JS via `eval` because a worker gets no TypeScript loader; the module
 * under test is reached through its exported SQL instead of an import.
 */
function consumeInWorker(dbPath: string, sql: string, startAt: number): Promise<number> {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require('better-sqlite3');
    const db = new Database(workerData.dbPath);
    db.pragma('journal_mode = WAL');
    // Spin to the shared barrier so every worker attempts at the same instant.
    const until = workerData.startAt;
    while (Date.now() < until) { /* spin to a shared start */ }
    let changes = 0;
    try {
      const r = db.prepare(workerData.sql).run(
        workerData.now, workerData.nonce, workerData.now,
        workerData.rpId, workerData.action, workerData.agentId,
      );
      changes = r.changes;
    } catch (err) {
      // SQLITE_BUSY under contention counts as "did not consume".
      changes = -1;
    }
    db.close();
    parentPort.postMessage(changes);
  `;

  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: {
        dbPath,
        sql,
        startAt,
        now: NOW,
        nonce: NONCE,
        rpId: VALID_ENV.WORLD_RP_ID,
        action: 'review-agent-42',
        agentId: '42',
      },
    });

    let changes: number | undefined;
    worker.once('message', (value: number) => {
      changes = value;
    });
    worker.once('error', reject);

    // Resolve on exit, not on the message, so the thread is actually gone
    // before the test moves on and the temp directory is removed.
    worker.once('exit', (code) => {
      if (changes === undefined) {
        reject(new Error(`worker exited with code ${code} before reporting a result`));
      } else {
        resolve(changes);
      }
    });
  });
}

/** One barrier shared by every worker in a race, computed before any starts. */
function raceStart(): number {
  return Date.now() + BARRIER_MS;
}

/** An outcome reported by a repository worker. */
interface WorkerOutcome {
  readonly ok: boolean;
  readonly replayed?: boolean | null;
  readonly reason: string | null;
  /** Set when the repository call threw — a SQLite lock error, for instance. */
  readonly threw: string | null;
}

/**
 * Run one of the repository workers and await its result.
 *
 * The worker is a TypeScript file loaded with `--import tsx`, so the race drives
 * the exported repository function itself rather than a copy of its SQL. It
 * resolves on `exit`, so the thread is gone before the temp directory goes.
 */
function runRepositoryWorker(
  file: 'consumeAuthorization' | 'consumeVerification',
  workerData: Record<string, unknown>,
): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`./workers/${file}.worker.ts`, import.meta.url), {
      execArgv: ['--import', 'tsx'],
      workerData,
    });

    let outcome: WorkerOutcome | undefined;
    worker.once('message', (value: WorkerOutcome) => {
      outcome = value;
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (outcome === undefined) {
        reject(new Error(`worker exited with code ${code} before reporting a result`));
      } else {
        resolve(outcome);
      }
    });
  });
}

describe('nonce consumption under real parallelism', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'receipts-race-'));
    dbPath = join(dir, 'requests.db');

    const db = openDatabase(dbPath);
    runMigrations(db);
    recordWorldIdRequest(db, {
      nonce: NONCE,
      rpId: VALID_ENV.WORLD_RP_ID,
      action: 'review-agent-42',
      agentId: '42',
      createdAt: NOW,
      expiresAt: NOW + 300,
    });
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets exactly one of several threads consume the same nonce', async () => {
    // Genuine OS-thread contention. A read-then-write implementation would let
    // more than one thread through here; the single-statement UPDATE cannot.
    // One timestamp for the whole race: computed once, handed to every worker,
    // so they spin to the same instant instead of each to its own.
    const startAt = raceStart();
    const results = await Promise.all(
      Array.from({ length: WORKERS }, () => consumeInWorker(dbPath, CONSUME_SQL, startAt)),
    );

    const consumed = results.filter((changes) => changes === 1);
    expect(consumed).toHaveLength(1);

    const db = openDatabase(dbPath);
    expect(findWorldIdRequest(db, NONCE)?.consumedAt).toBe(NOW);
    db.close();
  }, 30_000);

  it('demonstrates the statement is what provides the guarantee', async () => {
    // The same race against a read-then-write pair: this UPDATE omits the
    // `consumed_at IS NULL` guard, so several threads can succeed. It is run
    // only to show the previous test is capable of failing.
    const unguarded = `UPDATE world_id_requests
          SET consumed_at = ?
        WHERE nonce = ?
          AND expires_at > ?
          AND rp_id = ?
          AND action = ?
          AND agent_id = ?`;

    const startAt = raceStart();
    const results = await Promise.all(
      Array.from({ length: WORKERS }, () => consumeInWorker(dbPath, unguarded, startAt)),
    );

    expect(results.filter((changes) => changes === 1).length).toBeGreaterThan(1);
  }, 30_000);
});

describe('one review per (agent, human) under real parallelism', () => {
  let dir: string;
  let dbPath: string;
  const nonces = Array.from(
    { length: WORKERS },
    (_, i) => `0x${String(i).padStart(2, '0').repeat(32)}`,
  );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'receipts-dup-'));
    dbPath = join(dir, 'requests.db');

    const db = openDatabase(dbPath);
    runMigrations(db);
    // One issued request per worker: distinct nonces, same agent and human, so
    // only the first verification can satisfy UNIQUE (agent_id, nullifier).
    for (const nonce of nonces) {
      recordWorldIdRequest(db, {
        nonce,
        rpId: VALID_ENV.WORLD_RP_ID,
        action: 'review-agent-42',
        agentId: '42',
        createdAt: NOW,
        expiresAt: NOW + 300,
      });
    }
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets exactly one thread record a verification for the same nullifier', async () => {
    const startAt = raceStart();
    const results = await Promise.all(
      nonces.map((nonce) =>
        runRepositoryWorker('consumeVerification', {
          dbPath,
          nonce,
          rpId: VALID_ENV.WORLD_RP_ID,
          action: 'review-agent-42',
          agentId: '42',
          reviewer: REVIEWER,
          nullifier: NULLIFIER_DECIMAL,
          now: NOW,
          startAt,
        }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    // Contention must not surface as a lock error.
    expect(results.filter((r) => r.threw !== null)).toEqual([]);
    expect(new Set(results.filter((r) => !r.ok).map((r) => r.reason))).toEqual(
      new Set(['already_reviewed']),
    );

    const db = openDatabase(dbPath);
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_id_verifications').get()).toEqual({ n: 1 });
    // The losers rolled back completely: their requests are still unspent.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM world_id_requests WHERE consumed_at IS NOT NULL').get(),
    ).toEqual({ n: 1 });
    db.close();
  }, 30_000);
});

describe('wallet authorization under real parallelism', () => {
  let dir: string;
  let dbPath: string;
  const challenges = Array.from(
    { length: WORKERS },
    (_, i) => `0x${String(i).padStart(2, '0').repeat(32)}`,
  );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'receipts-auth-'));
    dbPath = join(dir, 'requests.db');

    const db = openDatabase(dbPath);
    runMigrations(db);
    recordWorldIdRequest(db, {
      nonce: NONCE,
      rpId: VALID_ENV.WORLD_RP_ID,
      action: 'review-agent-42',
      agentId: '42',
      createdAt: NOW - 100,
      expiresAt: NOW + 1000,
    });
    consumeAndRecordVerification(db, {
      nonce: NONCE,
      rpId: VALID_ENV.WORLD_RP_ID,
      action: 'review-agent-42',
      agentId: '42',
      reviewer: REVIEWER,
      nullifier: NULLIFIER_DECIMAL,
      now: NOW - 50,
    });

    // Several challenges for the one verification — a reviewer who redrafted.
    for (const nonce of challenges) {
      createReviewAuthorization(
        db,
        nonce as Hex,
        {
          verificationNonce: NONCE,
          agentId: '42',
          reviewer: REVIEWER,
          nullifier: nullifierToBytes32(NULLIFIER_DECIMAL),
          value: 80,
          valueDecimals: 0,
          feedbackHash: `0x${'44'.repeat(32)}`,
          reviewType: 0,
          receiptId: ZERO_BYTES32,
          deadline: NOW + 300,
        },
        NOW - 10,
      );
    }
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets exactly one challenge authorize the shared verification', async () => {
    const startAt = raceStart();
    const results = await Promise.all(
      challenges.map((nonce) =>
        runRepositoryWorker('consumeAuthorization', {
          dbPath,
          nonce,
          signature: SIGNATURE,
          now: NOW,
          startAt,
        }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    // The whole point of BEGIN IMMEDIATE plus busy_timeout: losers return a
    // classified failure rather than throwing SQLITE_BUSY.
    expect(results.filter((r) => r.threw !== null)).toEqual([]);
    expect(new Set(results.filter((r) => !r.ok).map((r) => r.reason))).toEqual(
      new Set(['verification_already_authorized']),
    );

    const db = openDatabase(dbPath);
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM review_authorizations WHERE consumed_at IS NOT NULL')
        .get(),
    ).toEqual({ n: 1 });
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM world_id_verifications WHERE authorized_at IS NOT NULL')
        .get(),
    ).toEqual({ n: 1 });
    // No partially updated rows: a consumed challenge always carries its
    // signature, and an unconsumed one never does.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM review_authorizations
             WHERE (consumed_at IS NULL) <> (signature IS NULL)`,
        )
        .get(),
    ).toEqual({ n: 0 });
    db.close();
  }, 30_000);

  it('replays rather than conflicting when the same signature races itself', async () => {
    // Every thread submits the identical signature against one challenge: one
    // consumes, the rest must see an idempotent replay, never a conflict.
    const startAt = raceStart();
    const sameChallenge = challenges[0] as string;

    const results = await Promise.all(
      Array.from({ length: WORKERS }, () =>
        runRepositoryWorker('consumeAuthorization', {
          dbPath,
          nonce: sameChallenge,
          signature: SIGNATURE,
          now: NOW,
          startAt,
        }),
      ),
    );

    expect(results.filter((r) => r.threw !== null)).toEqual([]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.replayed === false)).toHaveLength(1);
    expect(results.filter((r) => r.replayed === true)).toHaveLength(WORKERS - 1);
  }, 30_000);
});

describe('in-process consumption', () => {
  it('is serialized by the synchronous driver', () => {
    // Recorded for contrast: within one thread better-sqlite3 cannot interleave
    // two calls, so the parallel guarantee above is what actually matters.
    const db = openDatabase(IN_MEMORY);
    runMigrations(db);
    recordWorldIdRequest(db, {
      nonce: NONCE,
      rpId: VALID_ENV.WORLD_RP_ID,
      action: 'review-agent-42',
      agentId: '42',
      createdAt: NOW,
      expiresAt: NOW + 300,
    });

    const first = db
      .prepare(CONSUME_SQL)
      .run(NOW, NONCE, NOW, VALID_ENV.WORLD_RP_ID, 'review-agent-42', '42');
    const second = db
      .prepare(CONSUME_SQL)
      .run(NOW, NONCE, NOW, VALID_ENV.WORLD_RP_ID, 'review-agent-42', '42');

    expect([first.changes, second.changes]).toEqual([1, 0]);
    db.close();
  });
});

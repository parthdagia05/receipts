import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import type { Hex } from 'viem';
import { createPostgresRepository } from '../src/db/postgres/repository.js';
import { createTestDatabase, skipNotice } from './support/pg.js';
import { nullifierToBytes32 } from '../src/signing/reviewContent.js';

/**
 * The concurrency guarantees, proved against real PostgreSQL.
 *
 * This file exists because `concurrency.test.ts` cannot run against
 * PostgreSQL and must not be rewritten. That file is hard-coded to SQLite at
 * three levels — it imports `openDatabase`, it `require`s `better-sqlite3`
 * inside an inline worker's source, and it constructs a database from a
 * filesystem path. A PostgreSQL database has none of those. Rewriting the
 * test that proves the guarantee, in order to make the migration pass, is
 * exactly the inversion to avoid, so it is left byte-for-byte untouched and
 * keeps proving the SQLite behaviour it was written for.
 *
 * This file holds the same bar for the new backend: under genuine
 * concurrency, exactly one caller wins and the others receive a CLASSIFIED
 * FAILURE — never an exception, never a silently discarded challenge.
 *
 * Real parallelism here comes from separate pooled connections rather than
 * worker threads. Each promise below occupies its own backend process in
 * PostgreSQL, so the row locks are genuinely contended; worker threads would
 * add process overhead without adding contention the pool does not already
 * produce.
 */

const db = await createTestDatabase('concurrency', 16);
const pool = db.pool;
const describeIf = db.available ? describe : describe.skip;
skipNotice(db.available);

afterAll(async () => {
  await db.close();
});

const hex32 = (label: string): Hex => keccak256(toBytes(label));
const REVIEWER = '0x000000000000000000000000000000000000bEEF';
const ZERO32 = `0x${'00'.repeat(32)}` as Hex;

const RACERS = 8;

let seq = 0;

describeIf('PostgreSQL concurrency', () => {
  const repo = createPostgresRepository(pool);

  beforeEach(async () => {
    await db.reset();
  });

  async function makeRequest(agentId: string): Promise<string> {
    seq += 1;
    const nonce = hex32(`req-${seq}-${Date.now()}-${Math.random()}`);
    await repo.recordWorldIdRequest({
      nonce,
      rpId: 'rp_test',
      action: `review-agent-${agentId}`,
      agentId,
      createdAt: 1000,
      expiresAt: 9_999_999_999,
    });
    return nonce;
  }

  describe('nonce consumption under real parallelism', () => {
    it('lets exactly one of several connections consume the same request', async () => {
      const agentId = '100';
      const nonce = await makeRequest(agentId);

      const results = await Promise.all(
        Array.from({ length: RACERS }, (_, i) =>
          repo.consumeAndRecordVerification({
            nonce,
            rpId: 'rp_test',
            action: `review-agent-${agentId}`,
            agentId,
            reviewer: REVIEWER,
            // Distinct nullifiers, so the UNIQUE constraint is not what
            // decides the race: the request lock is.
            nullifier: String(900_000 + i),
            now: 2000,
          }),
        ),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      // Every loser is classified, not thrown.
      for (const loser of results.filter((r) => !r.ok)) {
        expect(loser.ok).toBe(false);
        if (!loser.ok) expect(loser.reason).toBe('already_consumed');
      }
    });
  });

  describe('one review per (agent, human) under real parallelism', () => {
    it('lets exactly one connection record a verification for the same nullifier', async () => {
      // The protocol rule. Eight separate requests, same (agent, nullifier):
      // UNIQUE (agent_id, nullifier) must admit exactly one.
      const agentId = '200';
      const nullifier = '123456789';
      const nonces = await Promise.all(Array.from({ length: RACERS }, () => makeRequest(agentId)));

      const results = await Promise.all(
        nonces.map((nonce) =>
          repo.consumeAndRecordVerification({
            nonce,
            rpId: 'rp_test',
            action: `review-agent-${agentId}`,
            agentId,
            reviewer: REVIEWER,
            nullifier,
            now: 2000,
          }),
        ),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const loser of results.filter((r) => !r.ok)) {
        if (!loser.ok) expect(loser.reason).toBe('already_reviewed');
      }

      const { rows } = await pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM world_id_verifications WHERE agent_id = $1',
        [agentId],
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it('leaves every losing request unspent, so no verification is burned', async () => {
      const agentId = '201';
      const nullifier = '987654321';
      const nonces = await Promise.all(Array.from({ length: RACERS }, () => makeRequest(agentId)));

      await Promise.all(
        nonces.map((nonce) =>
          repo.consumeAndRecordVerification({
            nonce,
            rpId: 'rp_test',
            action: `review-agent-${agentId}`,
            agentId,
            reviewer: REVIEWER,
            nullifier,
            now: 2000,
          }),
        ),
      );

      const spent = await Promise.all(
        nonces.map(async (nonce) => (await repo.findWorldIdRequest(nonce))?.consumedAt !== null),
      );
      // The transaction rolls back on the unique violation, so only the
      // winner's request is consumed.
      expect(spent.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('wallet authorization under real parallelism', () => {
    async function verifiedChallenge(agentId: string, nullifier: string): Promise<Hex> {
      const requestNonce = await makeRequest(agentId);
      await repo.consumeAndRecordVerification({
        nonce: requestNonce,
        rpId: 'rp_test',
        action: `review-agent-${agentId}`,
        agentId,
        reviewer: REVIEWER,
        nullifier,
        now: 2000,
      });

      seq += 1;
      const challengeNonce = hex32(`auth-${seq}-${Date.now()}-${Math.random()}`);
      await repo.createReviewAuthorization(
        challengeNonce,
        {
          verificationNonce: requestNonce,
          agentId,
          reviewer: REVIEWER,
          nullifier: nullifierToBytes32(nullifier),
          value: 75,
          valueDecimals: 0,
          feedbackHash: hex32(`content-${seq}`),
          reviewType: 0,
          receiptId: ZERO32,
          deadline: 9_999_999_999,
        },
        2000,
      );
      return challengeNonce;
    }

    it('consumes a challenge exactly once when racers share a signature', async () => {
      // Same signature from every racer: this is the honest retry storm, and
      // every caller must get the same success rather than one winner and
      // seven conflicts.
      const nonce = await verifiedChallenge('300', '300300');
      const signature = hex32('shared-signature') as Hex;

      const results = await Promise.all(
        Array.from({ length: RACERS }, () =>
          repo.consumeReviewAuthorization({ nonce, signature, now: 3000 }),
        ),
      );

      expect(results.every((r) => r.ok)).toBe(true);
      const fresh = results.filter((r) => r.ok && !r.replayed);
      expect(fresh).toHaveLength(1);
      expect(results.filter((r) => r.ok && r.replayed)).toHaveLength(RACERS - 1);
    });

    it('admits one signature and classifies the rest as conflicts', async () => {
      // Distinct signatures: two different signatures cannot both be the one
      // that was accepted, so exactly one wins and the others are conflicts.
      const nonce = await verifiedChallenge('301', '301301');

      const results = await Promise.all(
        Array.from({ length: RACERS }, (_, i) =>
          repo.consumeReviewAuthorization({
            nonce,
            signature: hex32(`sig-${i}`) as Hex,
            now: 3000,
          }),
        ),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const loser of results.filter((r) => !r.ok)) {
        if (!loser.ok) expect(loser.reason).toBe('signature_conflict');
      }
    });

    it('never throws under contention — every loser is classified', async () => {
      // The guarantee BEGIN IMMEDIATE provided in SQLite: a competing caller
      // waits for the lock and then observes committed state, rather than
      // failing with a lock error. FOR UPDATE must behave the same way.
      const nonce = await verifiedChallenge('302', '302302');

      const settled = await Promise.allSettled(
        Array.from({ length: RACERS }, (_, i) =>
          repo.consumeReviewAuthorization({
            nonce,
            signature: hex32(`s-${i}`) as Hex,
            now: 3000,
          }),
        ),
      );

      expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
    });

    it('lets only one of two sibling challenges bind the same verification', async () => {
      const agentId = '303';
      const nullifier = '303303';
      const first = await verifiedChallenge(agentId, nullifier);

      // A sibling inserted directly, bypassing the create-time guard, to
      // reach the consume-time rollback under contention.
      const verification = (await repo.findReviewAuthorization(first))?.verificationNonce;
      seq += 1;
      const sibling = hex32(`sib-${seq}-${Date.now()}`);
      await pool.query(
        `INSERT INTO review_authorizations
           (nonce, verification_nonce, agent_id, reviewer, nullifier, value,
            value_decimals, feedback_hash, review_type, receipt_id, deadline, created_at)
         VALUES ($1,$2,$3,$4,$5,60,0,$6,0,$7,9999999999,2000)`,
        [
          sibling,
          verification,
          agentId,
          REVIEWER,
          nullifierToBytes32(nullifier),
          hex32('sibling-content'),
          ZERO32,
        ],
      );

      const [a, b] = await Promise.all([
        repo.consumeReviewAuthorization({ nonce: first, signature: hex32('a') as Hex, now: 3000 }),
        repo.consumeReviewAuthorization({
          nonce: sibling,
          signature: hex32('b') as Hex,
          now: 3000,
        }),
      ]);

      const winners = [a, b].filter((r) => r.ok);
      expect(winners).toHaveLength(1);

      const loserNonce = a.ok ? sibling : first;
      const loser = await repo.findReviewAuthorization(loserNonce);
      // The rollback is the point: the loser stays unspent and can be
      // retried, rather than being consumed and silently discarded.
      expect(loser?.consumedAt).toBeNull();
      expect(loser?.signature).toBeNull();
    });
  });
});

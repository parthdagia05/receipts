import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import type { Hex } from 'viem';
import { createPostgresRepository } from '../src/db/postgres/repository.js';
import { createTestDatabase, skipNotice } from './support/pg.js';
import type { Repository } from '../src/db/repository.js';
import { nullifierToBytes32 } from '../src/signing/reviewContent.js';

/**
 * Integration tests against a real PostgreSQL.
 *
 * Not a mock and not pg-mem. The behaviours this migration has to preserve —
 * row locking, unique-violation classification, transaction rollback, trigger
 * enforcement — are precisely the ones an in-memory emulation gets subtly
 * wrong, and "subtly wrong" is how a correctness regression ships.
 *
 * Skipped, loudly, when no database is configured, so the suite stays green
 * on a machine without PostgreSQL rather than failing for the wrong reason.
 */

const db = await createTestDatabase('repository', 10);
const pool = db.pool;
const describeIf = db.available ? describe : describe.skip;
skipNotice(db.available);

afterAll(async () => {
  await db.close();
});

const hex32 = (label: string): Hex => keccak256(toBytes(label));

/** A real checksummed address: the binding guard runs getAddress() on it. */
const REVIEWER = '0x000000000000000000000000000000000000bEEF';

let repo: Repository;
let seq = 0;

async function freshRequest(agentId = '1'): Promise<{ nonce: string; agentId: string }> {
  seq += 1;
  const nonce = hex32(`request-${seq}-${Date.now()}`);
  await repo.recordWorldIdRequest({
    nonce,
    rpId: 'rp_test',
    action: `review-agent-${agentId}`,
    agentId,
    createdAt: 1000,
    expiresAt: 9_999_999_999,
  });
  return { nonce, agentId };
}

describeIf('PostgreSQL repository', () => {
  beforeEach(async () => {
    repo = createPostgresRepository(pool);
    // Order matters: children before parents, or the foreign keys reject it.
    await db.reset();
  });

  describe('reachability', () => {
    it('reports healthy against a live database', async () => {
      expect(await repo.isReachable()).toBe(true);
    });

    it('reports unhealthy rather than throwing when unreachable', async () => {
      const dead = createPostgresRepository({
        connectionString: 'postgres://nobody@127.0.0.1:1/none',
      });
      expect(await dead.isReachable()).toBe(false);
      await dead.close();
    });
  });

  describe('World ID requests', () => {
    it('round-trips a request with its integer fields as numbers', async () => {
      // BIGINT comes back from pg as a string; the records must not.
      const { nonce } = await freshRequest();
      const found = await repo.findWorldIdRequest(nonce);
      expect(found).toBeDefined();
      expect(typeof found?.createdAt).toBe('number');
      expect(found?.createdAt).toBe(1000);
      expect(found?.consumedAt).toBeNull();
    });

    it('matches nonces case-insensitively', async () => {
      const { nonce } = await freshRequest();
      expect(await repo.findWorldIdRequest(nonce.toUpperCase())).toBeDefined();
    });

    it('classifies an unknown nonce', async () => {
      expect(
        await repo.checkWorldIdRequestUsable({
          nonce: hex32('missing'),
          rpId: 'rp_test',
          action: 'review-agent-1',
          agentId: '1',
          now: 2000,
        }),
      ).toBe('unknown_nonce');
    });

    it('treats expiry as exclusive at the boundary', async () => {
      // At expires_at the request is already expired -- same rule as SQLite.
      const nonce = hex32(`boundary-${Date.now()}`);
      await repo.recordWorldIdRequest({
        nonce,
        rpId: 'rp_test',
        action: 'review-agent-1',
        agentId: '1',
        createdAt: 1000,
        expiresAt: 2000,
      });
      const args = {
        nonce,
        rpId: 'rp_test',
        action: 'review-agent-1',
        agentId: '1',
      };
      expect(await repo.checkWorldIdRequestUsable({ ...args, now: 1999 })).toBeUndefined();
      expect(await repo.checkWorldIdRequestUsable({ ...args, now: 2000 })).toBe('expired');
    });

    it('rejects a mismatched context', async () => {
      const { nonce } = await freshRequest();
      expect(
        await repo.checkWorldIdRequestUsable({
          nonce,
          rpId: 'rp_other',
          action: 'review-agent-1',
          agentId: '1',
          now: 2000,
        }),
      ).toBe('context_mismatch');
    });
  });

  describe('verifications', () => {
    const verify = async (nonce: string, agentId: string, nullifier: string, reviewer = REVIEWER) =>
      repo.consumeAndRecordVerification({
        nonce,
        rpId: 'rp_test',
        action: `review-agent-${agentId}`,
        agentId,
        reviewer,
        nullifier,
        now: 2000,
      });

    it('records a verification and spends the request', async () => {
      const { nonce } = await freshRequest();
      const result = await verify(nonce, '1', '111');
      expect(result.ok).toBe(true);
      expect((await repo.findWorldIdRequest(nonce))?.consumedAt).toBe(2000);
    });

    it('refuses to spend the same request twice', async () => {
      const { nonce } = await freshRequest();
      await verify(nonce, '1', '111');
      const second = await verify(nonce, '1', '222');
      expect(second).toEqual({ ok: false, reason: 'already_consumed' });
    });

    it('enforces one review per (agent, human)', async () => {
      // UNIQUE (agent_id, nullifier) is the protocol rule. Nothing else
      // enforces it server-side.
      const first = await freshRequest('7');
      const second = await freshRequest('7');
      expect((await verify(first.nonce, '7', '999')).ok).toBe(true);

      const blocked = await verify(second.nonce, '7', '999');
      expect(blocked).toEqual({ ok: false, reason: 'already_reviewed' });
    });

    it('leaves the request unspent when the nullifier is rejected', async () => {
      // The whole transaction rolls back, so a rejected proof does not burn
      // the user's verification.
      const first = await freshRequest('8');
      const second = await freshRequest('8');
      await verify(first.nonce, '8', '888');
      await verify(second.nonce, '8', '888');

      expect((await repo.findWorldIdRequest(second.nonce))?.consumedAt).toBeNull();
    });

    it('allows the same human to review a different agent', async () => {
      const a = await freshRequest('10');
      const b = await freshRequest('11');
      expect((await verify(a.nonce, '10', '555')).ok).toBe(true);
      expect((await verify(b.nonce, '11', '555')).ok).toBe(true);
    });
  });

  describe('authorizations', () => {
    async function verifiedRequest(agentId: string, nullifier: string) {
      const { nonce } = await freshRequest(agentId);
      await repo.consumeAndRecordVerification({
        nonce,
        rpId: 'rp_test',
        action: `review-agent-${agentId}`,
        agentId,
        reviewer: REVIEWER,
        nullifier,
        now: 2000,
      });
      return nonce;
    }

    async function challenge(verificationNonce: string, agentId: string, nullifier: string) {
      seq += 1;
      const nonce = hex32(`auth-${seq}-${Date.now()}`);
      await repo.createReviewAuthorization(
        nonce,
        {
          verificationNonce,
          agentId,
          reviewer: REVIEWER,
          nullifier: nullifierToBytes32(nullifier),
          value: 80,
          valueDecimals: 0,
          feedbackHash: hex32('content'),
          reviewType: 0,
          receiptId: `0x${'00'.repeat(32)}` as Hex,
          deadline: 9_999_999_999,
        },
        2000,
      );
      return nonce;
    }

    it('round-trips an authorization with numeric fields', async () => {
      const v = await verifiedRequest('20', '2000');
      const nonce = await challenge(v, '20', '2000');
      const found = await repo.findReviewAuthorization(nonce);
      expect(found?.value).toBe(80);
      expect(typeof found?.value).toBe('number');
      expect(found?.consumedAt).toBeNull();
      expect(found?.signature).toBeNull();
    });

    it('consumes a challenge exactly once', async () => {
      const v = await verifiedRequest('21', '2100');
      const nonce = await challenge(v, '21', '2100');
      const sig = hex32('sig') as Hex;

      const first = await repo.consumeReviewAuthorization({ nonce, signature: sig, now: 3000 });
      expect(first.ok).toBe(true);
      expect(first.ok && first.replayed).toBe(false);
      expect(await repo.isVerificationAuthorized(v)).toBe(true);
    });

    it('returns the original result for an identical retry', async () => {
      const v = await verifiedRequest('22', '2200');
      const nonce = await challenge(v, '22', '2200');
      const sig = hex32('sig') as Hex;

      await repo.consumeReviewAuthorization({ nonce, signature: sig, now: 3000 });
      const retry = await repo.consumeReviewAuthorization({ nonce, signature: sig, now: 3001 });
      expect(retry.ok).toBe(true);
      expect(retry.ok && retry.replayed).toBe(true);
    });

    it('reports signature_conflict for a different signature', async () => {
      // Two different signatures cannot both be the one that was accepted.
      const v = await verifiedRequest('23', '2300');
      const nonce = await challenge(v, '23', '2300');

      await repo.consumeReviewAuthorization({ nonce, signature: hex32('a') as Hex, now: 3000 });
      const other = await repo.consumeReviewAuthorization({
        nonce,
        signature: hex32('b') as Hex,
        now: 3001,
      });
      expect(other).toEqual({ ok: false, reason: 'signature_conflict' });
    });

    it('reports unknown_challenge for a nonce that does not exist', async () => {
      expect(
        await repo.consumeReviewAuthorization({
          nonce: hex32('nope'),
          signature: hex32('s') as Hex,
          now: 3000,
        }),
      ).toEqual({ ok: false, reason: 'unknown_challenge' });
    });

    it('rejects a challenge past its deadline', async () => {
      const v = await verifiedRequest('24', '2400');
      seq += 1;
      const nonce = hex32(`expiring-${seq}-${Date.now()}`);
      await repo.createReviewAuthorization(
        nonce,
        {
          verificationNonce: v,
          agentId: '24',
          reviewer: REVIEWER,
          nullifier: nullifierToBytes32('2400'),
          value: 50,
          valueDecimals: 0,
          feedbackHash: hex32('c'),
          reviewType: 0,
          receiptId: `0x${'00'.repeat(32)}` as Hex,
          deadline: 2500,
        },
        2000,
      );
      expect(
        await repo.consumeReviewAuthorization({ nonce, signature: hex32('s') as Hex, now: 9999 }),
      ).toEqual({ ok: false, reason: 'expired' });
    });

    it('ALLOWS a second challenge while the verification is unconsumed', async () => {
      // Matches SQLite: the create-time guard is `authorized_at IS NOT NULL`,
      // not "a challenge already exists". Two challenges may be issued; only
      // one may be consumed, and the loser is rolled back at consume time by
      // the test below. An earlier version of this test asserted a rejection
      // here and was wrong about the behaviour it was meant to protect.
      const v = await verifiedRequest('25', '2500');
      await challenge(v, '25', '2500');
      await expect(challenge(v, '25', '2500')).resolves.toBeDefined();
    });

    it('refuses a challenge whose agent does not match the verification', async () => {
      const v = await verifiedRequest('30', '3000');
      await expect(challenge(v, '31', '3000')).rejects.toThrow(/agent_mismatch/);
    });

    it('refuses a challenge whose nullifier does not match', async () => {
      const v = await verifiedRequest('32', '3200');
      await expect(challenge(v, '32', '9999')).rejects.toThrow(/nullifier_mismatch/);
    });

    it('refuses a challenge against an unknown verification', async () => {
      await expect(challenge(hex32('no-such-verification'), '33', '3300')).rejects.toThrow(
        /unknown_verification/,
      );
    });

    it('refuses a challenge once the verification is authorized', async () => {
      const v = await verifiedRequest('34', '3400');
      const first = await challenge(v, '34', '3400');
      await repo.consumeReviewAuthorization({
        nonce: first,
        signature: hex32('sig') as Hex,
        now: 3000,
      });
      await expect(challenge(v, '34', '3400')).rejects.toThrow(/verification_already_authorized/);
    });

    it('rolls back a losing sibling so it stays unspent', async () => {
      // Two challenges for one verification: the second must roll back
      // entirely rather than be consumed and silently discarded.
      const v = await verifiedRequest('26', '2600');
      const first = await challenge(v, '26', '2600');

      // Insert a sibling directly, bypassing the create-time guard, to
      // reach the consume-time rollback path.
      seq += 1;
      const sibling = hex32(`sibling-${seq}-${Date.now()}`);
      await pool.query(
        `INSERT INTO review_authorizations
           (nonce, verification_nonce, agent_id, reviewer, nullifier, value,
            value_decimals, feedback_hash, review_type, receipt_id, deadline, created_at)
         VALUES ($1,$2,'26',$3,$4,70,0,$5,0,$6,9999999999,2000)`,
        [sibling, v, REVIEWER, nullifierToBytes32('2600'), hex32('other'), `0x${'00'.repeat(32)}`],
      );

      await repo.consumeReviewAuthorization({
        nonce: first,
        signature: hex32('s1') as Hex,
        now: 3000,
      });
      const loser = await repo.consumeReviewAuthorization({
        nonce: sibling,
        signature: hex32('s2') as Hex,
        now: 3001,
      });

      expect(loser).toEqual({ ok: false, reason: 'verification_already_authorized' });
      // The rollback is the point: the sibling must still be unspent.
      expect((await repo.findReviewAuthorization(sibling))?.consumedAt).toBeNull();
      expect((await repo.findReviewAuthorization(sibling))?.signature).toBeNull();
    });
  });

  describe('review content', () => {
    it('derives the key from the content rather than accepting one', async () => {
      const content = toBytes('a review of an agent');
      await repo.putReviewContent({ content, createdAt: 5000 });

      const found = await repo.findReviewContent(keccak256(content));
      expect(found).not.toBeNull();
      expect(new TextDecoder().decode(found?.content)).toBe('a review of an agent');
    });

    it('reuses the row for identical content rather than erroring', async () => {
      const content = toBytes('duplicate text');
      await repo.putReviewContent({ content, createdAt: 5000 });
      await expect(repo.putReviewContent({ content, createdAt: 6000 })).resolves.toBeUndefined();
      // The first write wins; the row is not overwritten.
      expect((await repo.findReviewContent(keccak256(content)))?.createdAt).toBe(5000);
    });

    it('returns null for content it does not hold', async () => {
      expect(await repo.findReviewContent(hex32('absent'))).toBeNull();
    });

    it('is append-only: UPDATE is refused by the trigger', async () => {
      const content = toBytes('immutable');
      await repo.putReviewContent({ content, createdAt: 5000 });
      await expect(
        pool.query('UPDATE review_contents SET content = $1 WHERE feedback_hash = $2', [
          Buffer.from(toBytes('tampered')),
          keccak256(content),
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it('is append-only: DELETE is refused by the trigger', async () => {
      const content = toBytes('permanent');
      await repo.putReviewContent({ content, createdAt: 5000 });
      await expect(
        pool.query('DELETE FROM review_contents WHERE feedback_hash = $1', [keccak256(content)]),
      ).rejects.toThrow(/append-only/);
    });
  });
});

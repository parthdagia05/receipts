import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { IN_MEMORY, openDatabase } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { recordWorldIdRequest } from '../src/db/worldIdRequests.js';
import { consumeAndRecordVerification } from '../src/db/worldIdVerifications.js';
import {
  AuthorizationBindingError,
  consumeReviewAuthorization,
  createReviewAuthorization,
  findReviewAuthorization,
  generateAuthorizationNonce,
  isVerificationAuthorized,
  pruneExpiredReviewAuthorizations,
} from '../src/db/reviewAuthorizations.js';
import type {
  AuthorizationBindingFailure,
  NewReviewAuthorization,
} from '../src/db/reviewAuthorizations.js';
import { REVIEW_TYPE, ZERO_BYTES32, nullifierToBytes32 } from '../src/signing/reviewContent.js';
import { VALID_ENV } from './fixtures.js';
import { FIXTURE_NULLIFIER_BYTES32 } from './authorizationFixtures.js';

const RP_NONCE = `0x${'ab'.repeat(32)}`;
const CHALLENGE = `0x${'55'.repeat(32)}` as Hex;
const OTHER_CHALLENGE = `0x${'66'.repeat(32)}` as Hex;
const SIGNATURE = `0x${'cd'.repeat(65)}` as Hex;
const OTHER_SIGNATURE = `0x${'ef'.repeat(65)}` as Hex;
const NOW = 1_793_740_600;
const DEADLINE = NOW + 300;
const REVIEWER = '0xAbAbaBAbABabAbabAbaBABaBabababaBaBAbAbAb';

describe('review_authorizations', () => {
  let db: Db;

  /** A verified World ID proof for agent 42, which challenges hang off. */
  function seedVerification(rpNonce = RP_NONCE, agentId = '42'): void {
    recordWorldIdRequest(db, {
      nonce: rpNonce,
      rpId: VALID_ENV.WORLD_RP_ID,
      action: `review-agent-${agentId}`,
      agentId,
      createdAt: NOW - 100,
      expiresAt: NOW + 1000,
    });
    const recorded = consumeAndRecordVerification(db, {
      nonce: rpNonce,
      rpId: VALID_ENV.WORLD_RP_ID,
      action: `review-agent-${agentId}`,
      agentId,
      reviewer: REVIEWER,
      nullifier: agentId === '42' ? '7' : '8',
      now: NOW - 50,
    });
    expect(recorded.ok).toBe(true);
  }

  function newChallenge(overrides: Partial<NewReviewAuthorization> = {}): NewReviewAuthorization {
    return {
      verificationNonce: RP_NONCE,
      agentId: '42',
      reviewer: REVIEWER,
      nullifier: FIXTURE_NULLIFIER_BYTES32,
      value: 80,
      valueDecimals: 0,
      feedbackHash: `0x${'44'.repeat(32)}`,
      reviewType: REVIEW_TYPE.FREE,
      receiptId: ZERO_BYTES32,
      deadline: DEADLINE,
      ...overrides,
    };
  }

  function create(nonce: Hex = CHALLENGE, overrides: Partial<NewReviewAuthorization> = {}) {
    return createReviewAuthorization(db, nonce, newChallenge(overrides), NOW);
  }

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
    seedVerification();
  });

  afterEach(() => {
    db.close();
  });

  describe('migrations', () => {
    it('creates the challenge table with the expected columns', () => {
      const columns = (
        db.prepare(`PRAGMA table_info(review_authorizations)`).all() as { name: string }[]
      ).map((c) => c.name);

      expect(columns.sort()).toEqual([
        'agent_id',
        'consumed_at',
        'created_at',
        'deadline',
        'feedback_hash',
        'nonce',
        'nullifier',
        'receipt_id',
        'review_type',
        'reviewer',
        'signature',
        'value',
        'value_decimals',
        'verification_nonce',
      ]);
    });

    it('adds authorized_at to verifications, defaulting to unset', () => {
      const columns = (
        db.prepare(`PRAGMA table_info(world_id_verifications)`).all() as { name: string }[]
      ).map((c) => c.name);

      expect(columns).toContain('authorized_at');
      expect(isVerificationAuthorized(db, RP_NONCE)).toBe(false);
    });

    it('applies to a database that stopped at migration 002', () => {
      const older = openDatabase(IN_MEMORY);
      runMigrations(older, MIGRATIONS.slice(0, 2));

      expect(runMigrations(older)).toEqual([
        '003_review_authorizations',
        '004_verification_authorized_at',
        '005_review_contents',
        '006_wallet_review_authorizations',
      ]);
      older.close();
    });
  });

  describe('generateAuthorizationNonce', () => {
    it('produces a 32-byte hex nonce', () => {
      expect(generateAuthorizationNonce()).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('does not repeat', () => {
      const seen = new Set(Array.from({ length: 200 }, () => generateAuthorizationNonce()));
      expect(seen.size).toBe(200);
    });
  });

  describe('createReviewAuthorization', () => {
    it('stores the challenge and reads it back', () => {
      create();

      expect(findReviewAuthorization(db, CHALLENGE)).toEqual({
        nonce: CHALLENGE,
        verificationNonce: RP_NONCE,
        agentId: '42',
        reviewer: REVIEWER,
        nullifier: FIXTURE_NULLIFIER_BYTES32,
        value: 80,
        valueDecimals: 0,
        feedbackHash: `0x${'44'.repeat(32)}`,
        reviewType: REVIEW_TYPE.FREE,
        receiptId: ZERO_BYTES32,
        deadline: DEADLINE,
        createdAt: NOW,
        consumedAt: null,
        signature: null,
      });
    });

    it('allows several challenges for one verification', () => {
      // A reviewer may redraft; only one can ever be spent.
      create(CHALLENGE);
      create(OTHER_CHALLENGE, { value: 90 });

      expect(findReviewAuthorization(db, CHALLENGE)?.value).toBe(80);
      expect(findReviewAuthorization(db, OTHER_CHALLENGE)?.value).toBe(90);
    });

    describe('binding to the referenced verification', () => {
      /** Attempt a creation and assert nothing was written. */
      const rejects = (
        overrides: Partial<NewReviewAuthorization>,
        reason: AuthorizationBindingFailure,
      ): void => {
        let caught: unknown;
        try {
          create(CHALLENGE, overrides);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(AuthorizationBindingError);
        expect((caught as AuthorizationBindingError).reason).toBe(reason);
        // The transaction rolled back: no challenge row exists.
        expect(findReviewAuthorization(db, CHALLENGE)).toBeUndefined();
        expect(db.prepare('SELECT COUNT(*) AS n FROM review_authorizations').get()).toEqual({
          n: 0,
        });
      };

      it('accepts a challenge whose fields all match', () => {
        const created = create();

        expect(created.verificationNonce).toBe(RP_NONCE);
        expect(findReviewAuthorization(db, CHALLENGE)).toBeDefined();
      });

      it('rejects a verification that does not exist', () => {
        rejects({ verificationNonce: `0x${'99'.repeat(32)}` }, 'unknown_verification');
      });

      it('rejects a mismatched agent id', () => {
        // The foreign key would have allowed this: the verification exists, but
        // it is not a verification about agent 99.
        rejects({ agentId: '99' }, 'agent_mismatch');
      });

      it('rejects a mismatched reviewer', () => {
        rejects({ reviewer: `0x${'99'.repeat(20)}` }, 'reviewer_mismatch');
      });

      it('rejects a mismatched nullifier', () => {
        rejects({ nullifier: `0x${'00'.repeat(31)}08` }, 'nullifier_mismatch');
      });

      it('rejects a verification that is already authorized', () => {
        create(OTHER_CHALLENGE);
        expect(
          consumeReviewAuthorization(db, {
            nonce: OTHER_CHALLENGE,
            signature: SIGNATURE,
            now: NOW + 1,
          }).ok,
        ).toBe(true);

        let caught: unknown;
        try {
          create(CHALLENGE);
        } catch (err) {
          caught = err;
        }

        expect((caught as AuthorizationBindingError).reason).toBe(
          'verification_already_authorized',
        );
        expect(findReviewAuthorization(db, CHALLENGE)).toBeUndefined();
        // Only the already-consumed challenge remains.
        expect(db.prepare('SELECT COUNT(*) AS n FROM review_authorizations').get()).toEqual({
          n: 1,
        });
      });

      it('accepts a reviewer in a different checksum casing', () => {
        // Addresses are compared through getAddress, so casing cannot cause a
        // spurious mismatch.
        expect(() => create(CHALLENGE, { reviewer: REVIEWER.toLowerCase() })).not.toThrow();
      });

      it('derives the expected nullifier from the stored decimal', () => {
        // The check converts the verification's decimal with the same helper the
        // challenge was built from, rather than re-implementing it.
        expect(nullifierToBytes32('7')).toBe(FIXTURE_NULLIFIER_BYTES32);
        expect(() => create(CHALLENGE)).not.toThrow();
      });
    });

    it('rejects a deadline at or before creation', () => {
      expect(() => create(CHALLENGE, { deadline: NOW })).toThrow(/deadline/);
      expect(() => create(CHALLENGE, { deadline: NOW - 1 })).toThrow(/deadline/);
    });

    it('rejects a malformed nonce', () => {
      expect(() => create('0xabc' as Hex)).toThrow();
    });
  });

  describe('consumeReviewAuthorization', () => {
    beforeEach(() => {
      create();
    });

    it('spends the challenge and marks the verification authorized', () => {
      const result = consumeReviewAuthorization(db, {
        nonce: CHALLENGE,
        signature: SIGNATURE,
        now: NOW + 1,
      });

      expect(result.ok).toBe(true);
      expect(result.ok && result.replayed).toBe(false);
      expect(result.ok && result.authorization.signature).toBe(SIGNATURE);
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBe(NOW + 1);
      expect(isVerificationAuthorized(db, RP_NONCE)).toBe(true);
    });

    it('rejects an unknown challenge', () => {
      expect(
        consumeReviewAuthorization(db, {
          nonce: `0x${'11'.repeat(32)}`,
          signature: SIGNATURE,
          now: NOW,
        }),
      ).toEqual({ ok: false, reason: 'unknown_challenge' });
    });

    it('rejects an expired challenge and leaves it unspent', () => {
      const result = consumeReviewAuthorization(db, {
        nonce: CHALLENGE,
        signature: SIGNATURE,
        now: DEADLINE + 1,
      });

      expect(result).toEqual({ ok: false, reason: 'expired' });
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBeNull();
      expect(isVerificationAuthorized(db, RP_NONCE)).toBe(false);
    });

    it('rejects at the exact deadline', () => {
      // Expiry is exclusive, matching the RP-request convention.
      expect(
        consumeReviewAuthorization(db, { nonce: CHALLENGE, signature: SIGNATURE, now: DEADLINE }),
      ).toEqual({ ok: false, reason: 'expired' });
    });

    it('accepts one second before the deadline', () => {
      expect(
        consumeReviewAuthorization(db, {
          nonce: CHALLENGE,
          signature: SIGNATURE,
          now: DEADLINE - 1,
        }).ok,
      ).toBe(true);
    });

    describe('idempotency', () => {
      it('replays the original result for an identical signature', () => {
        const first = consumeReviewAuthorization(db, {
          nonce: CHALLENGE,
          signature: SIGNATURE,
          now: NOW + 1,
        });
        const retry = consumeReviewAuthorization(db, {
          nonce: CHALLENGE,
          signature: SIGNATURE,
          now: NOW + 99,
        });

        if (!first.ok || !retry.ok) throw new Error('both consumes should have succeeded');

        expect(retry.replayed).toBe(true);
        // The original outcome, not a re-consume: the timestamp is unchanged.
        expect(retry.authorization.consumedAt).toBe(NOW + 1);
        expect(retry.authorization).toEqual(first.authorization);
      });

      it('replays even after the deadline has passed', () => {
        consumeReviewAuthorization(db, { nonce: CHALLENGE, signature: SIGNATURE, now: NOW + 1 });

        const retry = consumeReviewAuthorization(db, {
          nonce: CHALLENGE,
          signature: SIGNATURE,
          now: DEADLINE + 1000,
        });

        expect(retry.ok).toBe(true);
        expect(retry.ok && retry.replayed).toBe(true);
      });

      it('is case-insensitive about the signature hex', () => {
        consumeReviewAuthorization(db, { nonce: CHALLENGE, signature: SIGNATURE, now: NOW + 1 });

        const retry = consumeReviewAuthorization(db, {
          nonce: CHALLENGE,
          signature: SIGNATURE.toUpperCase().replace('0X', '0x') as Hex,
          now: NOW + 2,
        });

        expect(retry.ok && retry.replayed).toBe(true);
      });

      it('conflicts on a different signature', () => {
        consumeReviewAuthorization(db, { nonce: CHALLENGE, signature: SIGNATURE, now: NOW + 1 });

        expect(
          consumeReviewAuthorization(db, {
            nonce: CHALLENGE,
            signature: OTHER_SIGNATURE,
            now: NOW + 2,
          }),
        ).toEqual({ ok: false, reason: 'signature_conflict' });
        // The stored signature is untouched.
        expect(findReviewAuthorization(db, CHALLENGE)?.signature).toBe(SIGNATURE);
      });

      it('writes nothing on a replay', () => {
        consumeReviewAuthorization(db, { nonce: CHALLENGE, signature: SIGNATURE, now: NOW + 1 });
        const before = findReviewAuthorization(db, CHALLENGE);

        consumeReviewAuthorization(db, { nonce: CHALLENGE, signature: SIGNATURE, now: NOW + 50 });

        expect(findReviewAuthorization(db, CHALLENGE)).toEqual(before);
      });
    });

    describe('one authorization per verification', () => {
      it('refuses a sibling challenge once one has been authorized', () => {
        create(OTHER_CHALLENGE, { value: 90 });

        expect(
          consumeReviewAuthorization(db, { nonce: CHALLENGE, signature: SIGNATURE, now: NOW + 1 })
            .ok,
        ).toBe(true);

        const sibling = consumeReviewAuthorization(db, {
          nonce: OTHER_CHALLENGE,
          signature: OTHER_SIGNATURE,
          now: NOW + 2,
        });

        expect(sibling).toEqual({ ok: false, reason: 'verification_already_authorized' });
      });

      it('rolls the sibling consume back entirely', () => {
        create(OTHER_CHALLENGE, { value: 90 });
        consumeReviewAuthorization(db, { nonce: CHALLENGE, signature: SIGNATURE, now: NOW + 1 });

        consumeReviewAuthorization(db, {
          nonce: OTHER_CHALLENGE,
          signature: OTHER_SIGNATURE,
          now: NOW + 2,
        });

        // Unspent and unsigned: the transaction undid both halves.
        const sibling = findReviewAuthorization(db, OTHER_CHALLENGE);
        expect(sibling?.consumedAt).toBeNull();
        expect(sibling?.signature).toBeNull();
        // And the first authorization still stands.
        expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBe(NOW + 1);
        expect(isVerificationAuthorized(db, RP_NONCE)).toBe(true);
      });

      it('allows a different verification to be authorized', () => {
        const otherRp = `0x${'cd'.repeat(32)}`;
        seedVerification(otherRp, '43');
        create(OTHER_CHALLENGE, {
          verificationNonce: otherRp,
          agentId: '43',
          // seedVerification records nullifier '8' for agent 43; the challenge
          // must carry that verification's own nullifier.
          nullifier: nullifierToBytes32('8'),
        });

        expect(
          consumeReviewAuthorization(db, { nonce: CHALLENGE, signature: SIGNATURE, now: NOW + 1 })
            .ok,
        ).toBe(true);
        expect(
          consumeReviewAuthorization(db, {
            nonce: OTHER_CHALLENGE,
            signature: OTHER_SIGNATURE,
            now: NOW + 2,
          }).ok,
        ).toBe(true);

        expect(isVerificationAuthorized(db, RP_NONCE)).toBe(true);
        expect(isVerificationAuthorized(db, otherRp)).toBe(true);
      });
    });

    it('lets exactly one of many repeated attempts consume', () => {
      const results = Array.from({ length: 10 }, (_, i) =>
        consumeReviewAuthorization(db, {
          nonce: CHALLENGE,
          signature: `0x${String(i).padStart(2, '0').repeat(65)}` as Hex,
          now: NOW + 1,
        }),
      );

      // The first consumes; the rest carry different signatures, so they conflict.
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(9);
    });
  });

  describe('pruneExpiredReviewAuthorizations', () => {
    it('removes expired unconsumed challenges and keeps spent ones', () => {
      create(CHALLENGE);
      create(OTHER_CHALLENGE, { value: 90 });
      consumeReviewAuthorization(db, { nonce: CHALLENGE, signature: SIGNATURE, now: NOW + 1 });

      expect(pruneExpiredReviewAuthorizations(db, DEADLINE + 1)).toBe(1);
      expect(findReviewAuthorization(db, OTHER_CHALLENGE)).toBeUndefined();
      // Spent challenges are the replay record.
      expect(findReviewAuthorization(db, CHALLENGE)).toBeDefined();
    });

    it('removes nothing before the deadline', () => {
      create();

      expect(pruneExpiredReviewAuthorizations(db, DEADLINE - 1)).toBe(0);
    });

    it('removes at the exact deadline, matching consume', () => {
      create();

      expect(pruneExpiredReviewAuthorizations(db, DEADLINE)).toBe(1);
    });
  });
});

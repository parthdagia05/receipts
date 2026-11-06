import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { findWorldIdRequest, recordWorldIdRequest } from '../src/db/worldIdRequests.js';
import {
  consumeAndRecordVerification,
  findVerificationByNonce,
  hasReviewed,
} from '../src/db/worldIdVerifications.js';
import { VALID_ENV } from './fixtures.js';

const NONCE = `0x${'ab'.repeat(32)}`;
const OTHER_NONCE = `0x${'cd'.repeat(32)}`;
const NOW = 1_793_740_600;
const EXPIRES = NOW + 300;
const REVIEWER = '0xAbAbaBAbABabAbabAbaBABaBabababaBaBAbAbAb';
const NULLIFIER = '123456789012345678901234567890';

describe('world_id_verifications', () => {
  let db: Db;

  function issue(nonce = NONCE, overrides: Record<string, unknown> = {}): void {
    recordWorldIdRequest(db, {
      nonce,
      rpId: VALID_ENV.WORLD_RP_ID,
      action: 'review-agent-42',
      agentId: '42',
      createdAt: NOW - 100,
      expiresAt: EXPIRES,
      ...overrides,
    } as never);
  }

  function record(nonce = NONCE, overrides: Record<string, unknown> = {}) {
    return consumeAndRecordVerification(db, {
      nonce,
      rpId: VALID_ENV.WORLD_RP_ID,
      action: 'review-agent-42',
      agentId: '42',
      reviewer: REVIEWER,
      nullifier: NULLIFIER,
      now: NOW,
      ...overrides,
    } as never);
  }

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('migration', () => {
    it('creates the table with the expected columns', () => {
      const columns = (
        db.prepare(`PRAGMA table_info(world_id_verifications)`).all() as { name: string }[]
      ).map((c) => c.name);

      // `authorized_at` is added by migration 004, for the wallet-authorization
      // lifecycle; it is null until a challenge is consumed.
      expect(columns.sort()).toEqual([
        'agent_id',
        'authorized_at',
        'nonce',
        'nullifier',
        'reviewer',
        'verified_at',
      ]);
    });

    it('leaves authorized_at unset on a fresh verification', () => {
      const columns = (
        db.prepare(`PRAGMA table_info(world_id_verifications)`).all() as {
          name: string;
          dflt_value: unknown;
        }[]
      ).filter((c) => c.name === 'authorized_at');

      expect(columns[0]?.dflt_value).toBeNull();
    });

    it('enforces uniqueness on (agent_id, nullifier)', () => {
      const indexes = db.prepare(`PRAGMA index_list(world_id_verifications)`).all() as {
        unique: number;
      }[];

      expect(indexes.some((i) => i.unique === 1)).toBe(true);
    });
  });

  describe('consumeAndRecordVerification', () => {
    it('consumes the request and records the verification together', () => {
      issue();
      const result = record();

      expect(result.ok).toBe(true);
      expect(findWorldIdRequest(db, NONCE)?.consumedAt).toBe(NOW);
      expect(findVerificationByNonce(db, NONCE)).toEqual({
        nonce: NONCE,
        agentId: '42',
        reviewer: REVIEWER,
        nullifier: NULLIFIER,
        verifiedAt: NOW,
      });
    });

    it.each([
      ['an unknown nonce', undefined, 'unknown_nonce'],
      ['an expired request', { expiresAt: NOW - 1 }, 'expired'],
      ['a mismatched agent', { agentId: '99' }, 'context_mismatch'],
      ['a mismatched rp', { rpId: 'rp_other' }, 'context_mismatch'],
    ] as const)('refuses %s', (_label, issueOverrides, reason) => {
      if (issueOverrides !== undefined) issue(NONCE, issueOverrides);

      const result = record();

      expect(result).toEqual({ ok: false, reason });
      expect(findVerificationByNonce(db, NONCE)).toBeUndefined();
    });

    it('refuses a request already consumed', () => {
      issue();
      expect(record().ok).toBe(true);

      expect(record()).toEqual({ ok: false, reason: 'already_consumed' });
    });

    it('rolls the consume back when the human already reviewed the agent', () => {
      issue();
      expect(record().ok).toBe(true);

      issue(OTHER_NONCE);
      const second = record(OTHER_NONCE);

      expect(second).toEqual({ ok: false, reason: 'already_reviewed' });
      // The transaction means neither half happened.
      expect(findWorldIdRequest(db, OTHER_NONCE)?.consumedAt).toBeNull();
      expect(findVerificationByNonce(db, OTHER_NONCE)).toBeUndefined();
      expect(db.prepare('SELECT COUNT(*) AS n FROM world_id_verifications').get()).toEqual({
        n: 1,
      });
    });

    it('allows the same nullifier against a different agent', () => {
      issue();
      expect(record().ok).toBe(true);

      issue(OTHER_NONCE, { agentId: '43', action: 'review-agent-43' });
      const second = record(OTHER_NONCE, { agentId: '43', action: 'review-agent-43' });

      expect(second.ok).toBe(true);
      expect(hasReviewed(db, '42', NULLIFIER)).toBe(true);
      expect(hasReviewed(db, '43', NULLIFIER)).toBe(true);
    });

    it('allows a different human to review the same agent', () => {
      issue();
      expect(record().ok).toBe(true);

      issue(OTHER_NONCE);
      expect(record(OTHER_NONCE, { nullifier: '999' }).ok).toBe(true);
    });

    it('refuses a verification for a request that was never issued', () => {
      // The foreign key makes an orphan verification impossible.
      expect(record()).toEqual({ ok: false, reason: 'unknown_nonce' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM world_id_verifications').get()).toEqual({
        n: 0,
      });
    });
  });

  describe('hasReviewed', () => {
    it('is false before any verification', () => {
      expect(hasReviewed(db, '42', NULLIFIER)).toBe(false);
    });

    it('is true after one', () => {
      issue();
      record();

      expect(hasReviewed(db, '42', NULLIFIER)).toBe(true);
    });

    it('is scoped to the agent and the nullifier', () => {
      issue();
      record();

      expect(hasReviewed(db, '43', NULLIFIER)).toBe(false);
      expect(hasReviewed(db, '42', '999')).toBe(false);
    });
  });

  describe('findVerificationByNonce', () => {
    it('returns undefined when none exists', () => {
      expect(findVerificationByNonce(db, NONCE)).toBeUndefined();
    });

    it('finds the record whatever the nonce casing', () => {
      issue();
      record();

      expect(findVerificationByNonce(db, NONCE.toUpperCase().replace('0X', '0x'))).toBeDefined();
    });
  });
});

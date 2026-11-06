import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import {
  DuplicateNonceError,
  InvalidRequestRecordError,
  consumeWorldIdRequest,
  findWorldIdRequest,
  normalizeNonce,
  pruneExpiredWorldIdRequests,
  recordWorldIdRequest,
} from '../src/db/worldIdRequests.js';
import type { NewWorldIdRequest } from '../src/db/worldIdRequests.js';
import { VALID_ENV } from './fixtures.js';

const NONCE = `0x${'ab'.repeat(32)}`;
const NOW = 1_793_740_542;
const EXPIRES = NOW + 300;

function newRequest(overrides: Partial<NewWorldIdRequest> = {}): NewWorldIdRequest {
  return {
    nonce: NONCE,
    rpId: VALID_ENV.WORLD_RP_ID,
    action: 'review-agent-42',
    agentId: '42',
    createdAt: NOW,
    expiresAt: EXPIRES,
    ...overrides,
  };
}

function consumeParams(overrides: Record<string, unknown> = {}) {
  return {
    nonce: NONCE,
    rpId: VALID_ENV.WORLD_RP_ID,
    action: 'review-agent-42',
    agentId: '42',
    now: NOW,
    ...overrides,
  } as Parameters<typeof consumeWorldIdRequest>[1];
}

describe('world_id_requests', () => {
  let db: Db;

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
        db.prepare(`PRAGMA table_info(world_id_requests)`).all() as { name: string }[]
      ).map((c) => c.name);

      expect(columns.sort()).toEqual([
        'action',
        'agent_id',
        'consumed_at',
        'created_at',
        'expires_at',
        'nonce',
        'rp_id',
      ]);
    });

    it('is applied by runMigrations and is idempotent', () => {
      expect(runMigrations(db)).toEqual([]); // already applied in beforeEach
    });

    it('applies cleanly to a database that only had the ledger', () => {
      // A database created before this chunk has schema_migrations but no
      // world_id_requests; migrating must add it rather than fail.
      const older = openDatabase(IN_MEMORY);
      runMigrations(older, []);

      expect(runMigrations(older)).toEqual(MIGRATIONS.map((m) => m.id));
      expect(findWorldIdRequest(older, NONCE)).toBeUndefined();
      older.close();
    });
  });

  describe('normalizeNonce', () => {
    it('lowercases a valid nonce', () => {
      expect(normalizeNonce(`0x${'AB'.repeat(32)}`)).toBe(`0x${'ab'.repeat(32)}`);
    });

    it.each([
      '',
      '0x',
      'abc',
      `0x${'ab'.repeat(31)}`,
      `0x${'ab'.repeat(33)}`,
      'ab'.repeat(32),
      `0x${'zz'.repeat(32)}`,
    ])('rejects %o', (value) => {
      expect(() => normalizeNonce(value)).toThrow(InvalidRequestRecordError);
    });

    it('does not echo the rejected value', () => {
      const bad = 'definitely-not-a-nonce-value-12345';
      expect(() => normalizeNonce(bad)).toThrow(/32-byte hex/);
      try {
        normalizeNonce(bad);
      } catch (err) {
        expect((err as Error).message).not.toContain(bad);
      }
    });
  });

  describe('recordWorldIdRequest', () => {
    it('stores a request and reads it back', () => {
      recordWorldIdRequest(db, newRequest());

      expect(findWorldIdRequest(db, NONCE)).toEqual({
        nonce: NONCE.toLowerCase(),
        rpId: VALID_ENV.WORLD_RP_ID,
        action: 'review-agent-42',
        agentId: '42',
        createdAt: NOW,
        expiresAt: EXPIRES,
        consumedAt: null,
      });
    });

    it('rejects a duplicate nonce at the database level', () => {
      recordWorldIdRequest(db, newRequest());

      expect(() => recordWorldIdRequest(db, newRequest())).toThrow(DuplicateNonceError);
      // Even with entirely different context, the nonce alone collides.
      expect(() =>
        recordWorldIdRequest(db, newRequest({ action: 'review-agent-99', agentId: '99' })),
      ).toThrow(DuplicateNonceError);
    });

    it('treats differently-cased nonces as the same nonce', () => {
      recordWorldIdRequest(db, newRequest());

      expect(() =>
        recordWorldIdRequest(db, newRequest({ nonce: NONCE.toUpperCase().replace('0X', '0x') })),
      ).toThrow(DuplicateNonceError);
    });

    it('stores a uint256 agentId without precision loss', () => {
      const big = (2n ** 256n - 1n).toString(10);
      recordWorldIdRequest(db, newRequest({ agentId: big, action: `review-agent-${big}` }));

      expect(findWorldIdRequest(db, NONCE)?.agentId).toBe(big);
    });

    it.each([
      ['a malformed nonce', { nonce: 'nope' }],
      ['an empty rpId', { rpId: '' }],
      ['an empty action', { action: '' }],
      ['a non-decimal agentId', { agentId: '0x2a' }],
      ['a negative createdAt', { createdAt: -1 }],
      ['a fractional expiresAt', { expiresAt: 1.5 }],
      ['expiry before creation', { createdAt: NOW, expiresAt: NOW - 1 }],
    ])('rejects %s', (_label, overrides) => {
      expect(() => recordWorldIdRequest(db, newRequest(overrides))).toThrow(
        InvalidRequestRecordError,
      );
      expect(findWorldIdRequest(db, NONCE)).toBeUndefined();
    });

    describe('agentId is validated independently of the route', () => {
      const reject = (agentId: string) =>
        expect(() => recordWorldIdRequest(db, newRequest({ agentId }))).toThrow(
          InvalidRequestRecordError,
        );

      it('rejects zero', () => {
        reject('0');
        expect(() => recordWorldIdRequest(db, newRequest({ agentId: '0' }))).toThrow(
          /greater than zero/,
        );
      });

      it.each(['042', '007', '00'])('rejects the leading-zero form %o', (agentId) => {
        reject(agentId);
      });

      it.each(['', ' ', '4 2', '4.2', '-1', '1e3', 'abc', '0x2a', '42n'])(
        'rejects the non-decimal value %o',
        (agentId) => {
          reject(agentId);
        },
      );

      it('rejects more than 78 digits', () => {
        reject('1'.repeat(79));
        reject('9'.repeat(100_000));
      });

      it('rejects a 78-digit value above uint256 max', () => {
        reject('9'.repeat(78));
      });

      it('accepts the exact uint256 maximum', () => {
        const max = (2n ** 256n - 1n).toString(10);
        expect(max).toHaveLength(78);

        recordWorldIdRequest(db, newRequest({ agentId: max }));
        expect(findWorldIdRequest(db, NONCE)?.agentId).toBe(max);
      });

      it('accepts one', () => {
        recordWorldIdRequest(db, newRequest({ agentId: '1' }));
        expect(findWorldIdRequest(db, NONCE)?.agentId).toBe('1');
      });

      it('stores nothing when the agentId is rejected', () => {
        reject('042');
        expect(db.prepare('SELECT COUNT(*) AS n FROM world_id_requests').get()).toEqual({ n: 0 });
      });
    });
  });

  describe('SQLite error classification', () => {
    it('reports a primary-key collision as DuplicateNonceError', () => {
      recordWorldIdRequest(db, newRequest());

      expect(() => recordWorldIdRequest(db, newRequest())).toThrow(DuplicateNonceError);
    });

    it('does not misclassify an unrelated constraint failure', () => {
      // A trigger abort raises SQLITE_CONSTRAINT_TRIGGER. It is a constraint
      // error, but not a duplicate nonce, and must not be relabelled as one —
      // that would present a schema fault as "already issued".
      db.exec(`
        CREATE TRIGGER reject_agent_7 BEFORE INSERT ON world_id_requests
        WHEN NEW.agent_id = '7'
        BEGIN SELECT RAISE(ABORT, 'agent 7 is not allowed'); END;
      `);

      let caught: unknown;
      try {
        recordWorldIdRequest(db, newRequest({ agentId: '7', action: 'review-agent-7' }));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught).not.toBeInstanceOf(DuplicateNonceError);
      expect((caught as Error).message).toContain('agent 7 is not allowed');
      expect((caught as { code?: string }).code).toBe('SQLITE_CONSTRAINT_TRIGGER');
    });

    it('still records a permitted row once the trigger does not fire', () => {
      db.exec(`
        CREATE TRIGGER reject_agent_7b BEFORE INSERT ON world_id_requests
        WHEN NEW.agent_id = '7'
        BEGIN SELECT RAISE(ABORT, 'agent 7 is not allowed'); END;
      `);

      recordWorldIdRequest(db, newRequest({ agentId: '8', action: 'review-agent-8' }));
      expect(findWorldIdRequest(db, NONCE)?.agentId).toBe('8');
    });
  });

  describe('findWorldIdRequest', () => {
    it('returns the bound request', () => {
      recordWorldIdRequest(db, newRequest());
      const found = findWorldIdRequest(db, NONCE);

      expect(found?.rpId).toBe(VALID_ENV.WORLD_RP_ID);
      expect(found?.action).toBe('review-agent-42');
      expect(found?.agentId).toBe('42');
    });

    it('returns undefined for an unknown nonce', () => {
      expect(findWorldIdRequest(db, `0x${'cd'.repeat(32)}`)).toBeUndefined();
    });

    it('finds a request whatever the hex casing', () => {
      recordWorldIdRequest(db, newRequest());

      expect(findWorldIdRequest(db, NONCE.toUpperCase().replace('0X', '0x'))).toBeDefined();
    });

    it('does not return a request issued for a different nonce', () => {
      recordWorldIdRequest(db, newRequest());
      recordWorldIdRequest(db, newRequest({ nonce: `0x${'cd'.repeat(32)}`, agentId: '7' }));

      expect(findWorldIdRequest(db, `0x${'cd'.repeat(32)}`)?.agentId).toBe('7');
      expect(findWorldIdRequest(db, NONCE)?.agentId).toBe('42');
    });
  });

  describe('consumeWorldIdRequest', () => {
    beforeEach(() => {
      recordWorldIdRequest(db, newRequest());
    });

    it('consumes an unspent, unexpired, matching request', () => {
      const result = consumeWorldIdRequest(db, consumeParams());

      expect(result.ok).toBe(true);
      expect(result.ok && result.request.consumedAt).toBe(NOW);
      expect(findWorldIdRequest(db, NONCE)?.consumedAt).toBe(NOW);
    });

    it('rejects an unknown nonce', () => {
      const result = consumeWorldIdRequest(db, consumeParams({ nonce: `0x${'cd'.repeat(32)}` }));

      expect(result).toEqual({ ok: false, reason: 'unknown_nonce' });
    });

    it('rejects a second consumption of the same request', () => {
      expect(consumeWorldIdRequest(db, consumeParams()).ok).toBe(true);

      const second = consumeWorldIdRequest(db, consumeParams());
      expect(second).toEqual({ ok: false, reason: 'already_consumed' });
    });

    it('rejects an expired request', () => {
      const result = consumeWorldIdRequest(db, consumeParams({ now: EXPIRES + 1 }));

      expect(result).toEqual({ ok: false, reason: 'expired' });
      expect(findWorldIdRequest(db, NONCE)?.consumedAt).toBeNull();
    });

    it('rejects a request at the exact expiry second', () => {
      // Expiry is exclusive: at expires_at the request is already expired.
      const result = consumeWorldIdRequest(db, consumeParams({ now: EXPIRES }));

      expect(result).toEqual({ ok: false, reason: 'expired' });
      expect(findWorldIdRequest(db, NONCE)?.consumedAt).toBeNull();
    });

    it('accepts a request one second before expiry', () => {
      expect(consumeWorldIdRequest(db, consumeParams({ now: EXPIRES - 1 })).ok).toBe(true);
      expect(findWorldIdRequest(db, NONCE)?.consumedAt).toBe(EXPIRES - 1);
    });

    it('classifies expiry the same way the statement filters it', () => {
      // The WHERE clause and the failure classification must agree, or a
      // rejected consume would be reported with the wrong reason.
      for (const now of [EXPIRES - 1, EXPIRES, EXPIRES + 1]) {
        const fresh = openDatabase(IN_MEMORY);
        runMigrations(fresh);
        recordWorldIdRequest(fresh, newRequest());

        const result = consumeWorldIdRequest(fresh, consumeParams({ now }));
        expect(result.ok).toBe(now < EXPIRES);
        if (!result.ok) expect(result.reason).toBe('expired');

        fresh.close();
      }
    });

    it.each([
      ['rpId', { rpId: 'rp_someone_else' }],
      ['action', { action: 'review-agent-99' }],
      ['agentId', { agentId: '99' }],
    ])('rejects a mismatched %s and leaves the request unspent', (_label, overrides) => {
      const result = consumeWorldIdRequest(db, consumeParams(overrides));

      expect(result).toEqual({ ok: false, reason: 'context_mismatch' });
      expect(findWorldIdRequest(db, NONCE)?.consumedAt).toBeNull();
    });

    it('cannot be consumed twice by interleaved callers', () => {
      // Both callers read the same unspent state before either writes, which is
      // the race a read-then-write implementation would lose.
      expect(findWorldIdRequest(db, NONCE)?.consumedAt).toBeNull();
      const before = findWorldIdRequest(db, NONCE);
      expect(before?.consumedAt).toBeNull();

      const first = consumeWorldIdRequest(db, consumeParams());
      const second = consumeWorldIdRequest(db, consumeParams());

      expect([first.ok, second.ok]).toEqual([true, false]);
    });

    it('lets exactly one of many repeated attempts succeed', () => {
      const results = Array.from({ length: 20 }, () => consumeWorldIdRequest(db, consumeParams()));

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(19);
    });

    it('rejects a second connection that read the request while it was unspent', () => {
      const dir = mkdtempSync(join(tmpdir(), 'receipts-nonce-'));
      const path = join(dir, 'requests.db');

      const a = openDatabase(path);
      const b = openDatabase(path);
      try {
        runMigrations(a);
        recordWorldIdRequest(a, newRequest());

        // B observes the request as unspent, then A spends it.
        expect(findWorldIdRequest(b, NONCE)?.consumedAt).toBeNull();
        expect(consumeWorldIdRequest(a, consumeParams()).ok).toBe(true);

        // B's earlier read must not entitle it to consume.
        const viaB = consumeWorldIdRequest(b, consumeParams());
        expect(viaB).toEqual({ ok: false, reason: 'already_consumed' });
      } finally {
        a.close();
        b.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('consumes each of two requests independently', () => {
      const other = `0x${'cd'.repeat(32)}`;
      recordWorldIdRequest(db, newRequest({ nonce: other }));

      expect(consumeWorldIdRequest(db, consumeParams()).ok).toBe(true);
      expect(consumeWorldIdRequest(db, consumeParams({ nonce: other })).ok).toBe(true);
    });
  });

  describe('pruneExpiredWorldIdRequests', () => {
    it('removes expired unconsumed requests and keeps the rest', () => {
      recordWorldIdRequest(db, newRequest());
      recordWorldIdRequest(db, newRequest({ nonce: `0x${'cd'.repeat(32)}` }));
      consumeWorldIdRequest(db, consumeParams({ nonce: `0x${'cd'.repeat(32)}` }));

      expect(pruneExpiredWorldIdRequests(db, EXPIRES + 1)).toBe(1);
      expect(findWorldIdRequest(db, NONCE)).toBeUndefined();
      // A consumed request is retained: it is the record of a spent nonce.
      expect(findWorldIdRequest(db, `0x${'cd'.repeat(32)}`)).toBeDefined();
    });

    it('removes nothing before expiry', () => {
      recordWorldIdRequest(db, newRequest());

      expect(pruneExpiredWorldIdRequests(db, NOW)).toBe(0);
      expect(pruneExpiredWorldIdRequests(db, EXPIRES - 1)).toBe(0);
    });

    it('removes a request at the exact expiry second, matching consume', () => {
      recordWorldIdRequest(db, newRequest());

      expect(pruneExpiredWorldIdRequests(db, EXPIRES)).toBe(1);
    });
  });
});

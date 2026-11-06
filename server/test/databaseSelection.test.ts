import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, redactEnv } from '../src/config/env.js';
import { VALID_ENV } from './fixtures.js';

/**
 * Guards on how the production database is chosen.
 *
 * The failure these prevent is specific and quiet: a production deployment
 * that forgets `DATABASE_DRIVER` and starts on SQLite. Every task would get
 * its own file, `UNIQUE (agent_id, nullifier)` would stop being a global
 * constraint, and the server would issue signed attestations the chain then
 * rejects — burning the user's gas to discover it. Nothing would look broken
 * until someone inspected the data.
 */

const PG_URL = 'postgres://user:pw@db.internal:5432/receipts';

describe('database driver selection', () => {
  it('defaults to sqlite outside production', () => {
    expect(loadEnv(VALID_ENV).databaseDriver).toBe('sqlite');
  });

  it('accepts postgres when a connection string is supplied', () => {
    const env = loadEnv({ ...VALID_ENV, DATABASE_DRIVER: 'postgres', DATABASE_URL: PG_URL });
    expect(env.databaseDriver).toBe('postgres');
    expect(env.databaseUrl).toBe(PG_URL);
  });

  it('refuses postgres without a connection string', () => {
    expect(() => loadEnv({ ...VALID_ENV, DATABASE_DRIVER: 'postgres' })).toThrow(
      /DATABASE_URL.*required when DATABASE_DRIVER is postgres/s,
    );
  });

  it('refuses an unrecognised driver rather than guessing', () => {
    expect(() => loadEnv({ ...VALID_ENV, DATABASE_DRIVER: 'mysql' })).toThrow(
      /must be one of: sqlite, postgres/,
    );
  });

  describe('production cannot silently select sqlite', () => {
    it('refuses to start in production with the driver unset', () => {
      // The whole point: an omitted variable must not mean "sqlite".
      expect(() => loadEnv({ ...VALID_ENV, NODE_ENV: 'production' })).toThrow(
        /must be "postgres" when NODE_ENV is production/,
      );
    });

    it('refuses to start in production with sqlite set explicitly', () => {
      expect(() =>
        loadEnv({ ...VALID_ENV, NODE_ENV: 'production', DATABASE_DRIVER: 'sqlite' }),
      ).toThrow(/must be "postgres" when NODE_ENV is production/);
    });

    it('starts in production with postgres configured', () => {
      const env = loadEnv({
        ...VALID_ENV,
        NODE_ENV: 'production',
        DATABASE_DRIVER: 'postgres',
        DATABASE_URL: PG_URL,
      });
      expect(env.databaseDriver).toBe('postgres');
      expect(env.nodeEnv).toBe('production');
    });

    it('reports both faults at once when production has neither', () => {
      // loadEnv collects every issue, so one boot surfaces all of them
      // rather than making an operator fix them one restart at a time.
      try {
        loadEnv({ ...VALID_ENV, NODE_ENV: 'production', DATABASE_DRIVER: 'postgres' });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(String(error)).toMatch(/DATABASE_URL/);
      }
    });
  });

  describe('connection string is treated as a secret', () => {
    it('never appears in the redacted configuration', () => {
      const env = loadEnv({ ...VALID_ENV, DATABASE_DRIVER: 'postgres', DATABASE_URL: PG_URL });
      // It carries the database password.
      const redacted = redactEnv(env);
      expect(redacted['databaseUrl']).toBe('[redacted]');
      expect(JSON.stringify(redacted)).not.toContain('pw@db.internal');
    });
  });
});

/**
 * A structural check, not a behavioural one.
 *
 * Every route handler must reach the database through the injected
 * repository. A direct import of a `db/*` module would compile, pass its
 * tests against SQLite, and then run against SQLite in production too,
 * bypassing the interface entirely. That is exactly the regression this
 * sprint exists to prevent, so it is asserted rather than trusted.
 */
describe('routes use the injected repository', () => {
  const routesDir = new URL('../src/routes/', import.meta.url).pathname;
  const files = readdirSync(routesDir).filter((f) => f.endsWith('.ts'));

  it('finds the route files', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  /**
   * Functions that execute a query. Importing one into a route bypasses the
   * repository and pins that route to SQLite.
   *
   * Error classes and pure helpers from the same modules are fine and are
   * deliberately not listed: `AuthorizationBindingError` is what a catch
   * block tests with `instanceof`, and `generateAuthorizationNonce` is
   * `randomBytes`. Banning whole modules would force those to move for no
   * safety gain.
   */
  const DATA_ACCESS = [
    'recordWorldIdRequest',
    'findWorldIdRequest',
    'checkWorldIdRequestUsable',
    'consumeWorldIdRequest',
    'consumeAndRecordVerification',
    'findVerificationByNonce',
    'hasReviewed',
    'createReviewAuthorization',
    'findReviewAuthorization',
    'consumeReviewAuthorization',
    'isVerificationAuthorized',
    'putReviewContent',
    'findReviewContent',
    'isDatabaseReachable',
    'openDatabase',
  ] as const;

  for (const file of files) {
    it(`${file} calls no SQLite data-access function directly`, () => {
      const source = readFileSync(join(routesDir, file), 'utf8');
      // The lookbehind matters: `deps.repo.findReviewContent(` is the
      // correct call and must not match. Only a bare, unqualified call is a
      // direct SQLite import being used.
      const leaked = DATA_ACCESS.filter((fn) => new RegExp(`(?<![.\\w])${fn}\\s*\\(`).test(source));
      expect(leaked, `${file} calls ${leaked.join(', ')}`).toEqual([]);
    });
  }

  it('no route imports better-sqlite3', () => {
    for (const file of files) {
      expect(readFileSync(join(routesDir, file), 'utf8')).not.toContain('better-sqlite3');
    }
  });
});

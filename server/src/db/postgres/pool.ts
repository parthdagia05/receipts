import pg from 'pg';
import { SCHEMA_ADVISORY_LOCK, SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

/**
 * Connection pooling and schema application.
 *
 * Sizing: 10 connections per process. PostgreSQL 16's default
 * `max_connections` is 100, so one instance uses a tenth of it and there is
 * room for a psql session and a backup job alongside. The limit that matters
 * is the database's, not the pool's, and leaving nine tenths free is cheap
 * insurance against being locked out of a database that is misbehaving.
 */

export type PgPool = pg.Pool;

export interface PoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  /**
   * Caps how long a statement may run. Without it a lock wait is unbounded
   * and a stuck transaction holds a request open until the client gives up.
   * This is the PostgreSQL counterpart of SQLite's `busy_timeout`.
   */
  readonly statementTimeoutMs?: number;
}

const DEFAULT_MAX = 10;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

export function createPool(options: PoolOptions): PgPool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? DEFAULT_MAX,
    // Explicit, because the defaults hold connections open across a deploy
    // and leave the old process's sockets lingering on the database.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
  });

  // An idle client erroring (a server restart, a dropped network) emits on
  // the pool. Unhandled, it takes the process down. The message can carry the
  // connection string, so only the error's name is logged.
  pool.on('error', (error) => {
    console.error('[db] idle client error:', error.name);
  });

  return pool;
}

/**
 * Apply the schema, once, under an advisory lock.
 *
 * Two processes starting together would otherwise both run the DDL.
 * `CREATE TABLE IF NOT EXISTS` makes that mostly harmless, but "mostly" is
 * not something to rely on during a deploy, and the trigger statements are
 * not idempotent in the same way. SQLite needed no equivalent because it had
 * a single writer by construction.
 */
export async function applySchema(pool: PgPool): Promise<{ applied: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_ADVISORY_LOCK.toString()]);
    try {
      await client.query('BEGIN');
      await client.query(SCHEMA_SQL);
      const { rowCount } = await client.query(
        `INSERT INTO schema_version (version, applied_at) VALUES ($1, $2)
         ON CONFLICT (version) DO NOTHING`,
        [SCHEMA_VERSION, Math.floor(Date.now() / 1000)],
      );
      await client.query('COMMIT');
      return { applied: (rowCount ?? 0) > 0 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_ADVISORY_LOCK.toString()]);
    }
  } finally {
    client.release();
  }
}

/** Whether the database answers. Backs `GET /health`; never throws. */
export async function isReachable(pool: PgPool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * The client is passed in so every statement in the callback runs on the same
 * connection. Using the pool inside a transaction is the classic way to leak
 * one: the BEGIN lands on one connection and the UPDATE on another.
 */
export async function withTransaction<T>(
  pool: PgPool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the pool discards it on release.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** PostgreSQL's unique-violation SQLSTATE. */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

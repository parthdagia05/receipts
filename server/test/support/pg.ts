import { applySchema, createPool } from '../../src/db/postgres/pool.js';
import type { PgPool } from '../../src/db/postgres/pool.js';

/**
 * An isolated PostgreSQL schema per test file.
 *
 * Vitest runs test files in parallel. Two files sharing one set of tables
 * TRUNCATE each other's rows mid-test, which shows up as the kind of
 * intermittent failure that gets re-run until it passes rather than
 * diagnosed. Each file gets its own namespace instead, so parallelism is
 * free and the suite has no ordering requirement.
 *
 * A schema rather than a database: `CREATE SCHEMA` is cheap and runs on the
 * same connection, where `CREATE DATABASE` cannot run inside a transaction
 * and needs a separate administrative connection.
 */

export interface TestDatabase {
  readonly pool: PgPool;
  readonly available: boolean;
  readonly schema: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  `postgres://${process.env['USER'] ?? 'postgres'}@localhost:5432/receipts_test`;

/**
 * @param name A stable identifier for the calling test file.
 * @param max  Connection ceiling; concurrency tests need one per racer.
 */
export async function createTestDatabase(name: string, max = 10): Promise<TestDatabase> {
  const schema = `test_${name.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;

  // `options` pins search_path for every connection the pool opens, so the
  // unqualified table names in the repository resolve into this schema.
  const pool = createPool({ connectionString: DATABASE_URL, max });
  // The pool's own options cannot be set through the connection string
  // helper, so the search_path is established per connection on `connect`.
  pool.on('connect', (client) => {
    void client.query(`SET search_path TO ${schema}`);
  });

  let available = false;
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await applySchema(pool);
    available = true;
  } catch {
    available = false;
  }

  return {
    pool,
    available,
    schema,

    async reset() {
      await pool.query(
        `TRUNCATE ${schema}.review_authorizations, ${schema}.world_id_verifications, ${schema}.world_id_requests, ${schema}.review_contents`,
      );
    },

    async close() {
      try {
        // Dropped so a renamed or deleted test file does not leave a schema
        // behind in a developer's database forever.
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } catch {
        // Already gone, or the database was never reachable.
      }
      await pool.end().catch(() => undefined);
    },
  };
}

export function skipNotice(available: boolean): void {
  if (available) return;
  console.warn(
    `\n  PostgreSQL tests SKIPPED: could not reach ${DATABASE_URL.replace(/\/\/[^@]*@/, '//***@')}\n` +
      '  Start PostgreSQL and `createdb receipts_test` to run them.\n',
  );
}

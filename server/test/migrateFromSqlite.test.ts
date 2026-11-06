import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateFromSqlite } from '../src/db/postgres/migrateFromSqlite.js';
import { openDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { createTestDatabase, skipNotice } from './support/pg.js';

/**
 * The SQLite → PostgreSQL copy utility.
 *
 * The property this file exists to protect is the first one: the source is
 * never written to. Everything else is recoverable; a damaged source is not.
 */

const db = await createTestDatabase('migrate', 10);
const pool = db.pool;
const describeIf = db.available ? describe : describe.skip;
skipNotice(db.available);

afterAll(async () => {
  await db.close();
});

/** A populated SQLite database, built through the real migrations. */
function makeSource(): string {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-migrate-'));
  const path = join(dir, 'source.db');
  const sqlite = openDatabase(path);
  runMigrations(sqlite);

  sqlite
    .prepare(
      `INSERT INTO world_id_requests (nonce, rp_id, action, agent_id, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('0xreq1', 'rp_test', 'review-agent-1', '1', 1000, 2000, 1500);
  sqlite
    .prepare(
      `INSERT INTO world_id_requests (nonce, rp_id, action, agent_id, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('0xreq2', 'rp_test', 'review-agent-2', '2', 1000, 9000, null);

  sqlite
    .prepare(
      `INSERT INTO world_id_verifications (nonce, agent_id, reviewer, nullifier, verified_at, authorized_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('0xreq1', '1', '0xBeeF', '555', 1500, null);

  sqlite
    .prepare(
      `INSERT INTO review_authorizations
         (nonce, verification_nonce, agent_id, reviewer, nullifier, value, value_decimals,
          feedback_hash, review_type, receipt_id, deadline, created_at, consumed_at, signature)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      '0xauth1',
      '0xreq1',
      '1',
      '0xBeeF',
      '0xnull',
      80,
      0,
      '0xhash',
      0,
      '0xzero',
      9000,
      1600,
      null,
      null,
    );

  sqlite
    .prepare('INSERT INTO review_contents (feedback_hash, content, created_at) VALUES (?, ?, ?)')
    .run('0xcontenthash', Buffer.from('a stored review'), 1700);

  sqlite.close();
  return path;
}

describeIf('migrateFromSqlite', () => {
  beforeEach(async () => {
    await db.reset();
  });

  it('copies every table in foreign-key order', async () => {
    const report = await migrateFromSqlite({ sqlitePath: makeSource(), pool });

    expect(report.complete).toBe(true);
    expect(report.totalSource).toBe(5);
    expect(report.totalInserted).toBe(5);
    expect(report.totalFailed).toBe(0);
  });

  it('preserves ids and relationships', async () => {
    await migrateFromSqlite({ sqlitePath: makeSource(), pool });

    const { rows } = await pool.query<{ nonce: string; verification_nonce: string }>(
      'SELECT nonce, verification_nonce FROM review_authorizations',
    );
    expect(rows[0]?.nonce).toBe('0xauth1');
    // The FK resolved, which only works if the parents landed first.
    expect(rows[0]?.verification_nonce).toBe('0xreq1');
  });

  it('preserves nullable columns as null rather than defaulting them', async () => {
    await migrateFromSqlite({ sqlitePath: makeSource(), pool });
    const { rows } = await pool.query<{ consumed_at: string | null }>(
      "SELECT consumed_at FROM world_id_requests WHERE nonce = '0xreq2'",
    );
    expect(rows[0]?.consumed_at).toBeNull();
  });

  it('preserves integer values exactly', async () => {
    await migrateFromSqlite({ sqlitePath: makeSource(), pool });
    const { rows } = await pool.query<{ consumed_at: string; expires_at: string }>(
      "SELECT consumed_at, expires_at FROM world_id_requests WHERE nonce = '0xreq1'",
    );
    expect(Number(rows[0]?.consumed_at)).toBe(1500);
    expect(Number(rows[0]?.expires_at)).toBe(2000);
  });

  it('copies BLOB content into BYTEA byte-for-byte', async () => {
    await migrateFromSqlite({ sqlitePath: makeSource(), pool });
    const { rows } = await pool.query<{ content: Buffer }>(
      "SELECT content FROM review_contents WHERE feedback_hash = '0xcontenthash'",
    );
    expect(rows[0]?.content.toString()).toBe('a stored review');
  });

  it('is safe to rerun: the second pass inserts nothing', async () => {
    const source = makeSource();
    const first = await migrateFromSqlite({ sqlitePath: source, pool });
    const second = await migrateFromSqlite({ sqlitePath: source, pool });

    expect(first.totalInserted).toBe(5);
    // Visibly a no-op rather than silently looking like a fresh migration.
    expect(second.totalInserted).toBe(0);
    expect(second.tables.reduce((sum, t) => sum + t.skipped, 0)).toBe(5);
    expect(second.complete).toBe(true);
  });

  it('NEVER modifies the source database', async () => {
    // The property that matters most: the source is the only copy.
    const source = makeSource();
    const before = statSync(source);
    const checksumBefore = new Database(source, { readonly: true })
      .prepare('SELECT COUNT(*) AS n FROM world_id_requests')
      .get() as { n: number };

    await migrateFromSqlite({ sqlitePath: source, pool });

    const after = statSync(source);
    const checksumAfter = new Database(source, { readonly: true })
      .prepare('SELECT COUNT(*) AS n FROM world_id_requests')
      .get() as { n: number };

    expect(after.size).toBe(before.size);
    expect(checksumAfter.n).toBe(checksumBefore.n);
    expect(checksumAfter.n).toBe(2);
  });

  it('reports a row it could not insert instead of discarding it', async () => {
    // An orphan verification: its request is absent, so the foreign key
    // rejects it. It must appear in the report, not vanish.
    const dir = mkdtempSync(join(tmpdir(), 'receipts-orphan-'));
    const path = join(dir, 'orphan.db');
    const sqlite = openDatabase(path);
    runMigrations(sqlite);
    sqlite.pragma('foreign_keys = OFF');
    sqlite
      .prepare(
        `INSERT INTO world_id_verifications (nonce, agent_id, reviewer, nullifier, verified_at, authorized_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('0xorphan', '9', '0xBeeF', '777', 1500, null);
    sqlite.close();

    const report = await migrateFromSqlite({ sqlitePath: path, pool });

    expect(report.complete).toBe(false);
    expect(report.totalFailed).toBe(1);
    const verifications = report.tables.find((t) => t.table === 'world_id_verifications');
    expect(verifications?.failures[0]?.key).toBe('0xorphan');
    expect(verifications?.failures[0]?.error).toMatch(/foreign key/i);
  });

  it('treats a table missing from an older source as zero rows, not an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipts-partial-'));
    const path = join(dir, 'partial.db');
    const sqlite = new Database(path);
    sqlite.exec(`CREATE TABLE world_id_requests (
      nonce TEXT PRIMARY KEY, rp_id TEXT, action TEXT, agent_id TEXT,
      created_at INTEGER, expires_at INTEGER, consumed_at INTEGER)`);
    sqlite.close();

    const report = await migrateFromSqlite({ sqlitePath: path, pool });
    expect(report.complete).toBe(true);
    expect(report.tables.find((t) => t.table === 'review_contents')?.source).toBe(0);
  });

  it('refuses a source file that does not exist', async () => {
    await expect(
      migrateFromSqlite({ sqlitePath: '/nonexistent/receipts.db', pool }),
    ).rejects.toThrow();
  });
});

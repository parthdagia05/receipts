import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Path that opens a private, non-persistent database. */
export const IN_MEMORY = ':memory:';

/** How long a writer waits for the write lock before giving up. */
export const BUSY_TIMEOUT_MS = 5_000;

/**
 * Open a SQLite database, creating the parent directory for a file path.
 *
 * WAL keeps readers from blocking the writer, and `foreign_keys` is off by
 * default in SQLite, so both are set on every connection rather than once at
 * creation time.
 */
export function openDatabase(path: string): Db {
  if (path !== IN_MEMORY) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  // First, before anything that can itself contend for a lock. Under WAL only
  // one connection may write at a time, and without a timeout a competing
  // writer fails instantly with SQLITE_BUSY instead of waiting — including the
  // journal_mode switch below, which takes a lock of its own.
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // REPLACE deletes the conflicting row before inserting, but SQLite fires the
  // resulting delete triggers only when this is on. Off, `INSERT OR REPLACE`
  // walks straight past review_contents' append-only triggers and rewrites
  // content whose hash is already signed into an on-chain attestation.
  db.pragma('recursive_triggers = ON');
  return db;
}

/**
 * Whether the database answers a trivial query.
 *
 * Used by the health endpoint, so it reports a boolean instead of propagating
 * the driver error, which can name the database file.
 */
export function isDatabaseReachable(db: Db): boolean {
  try {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    return row?.ok === 1;
  } catch {
    return false;
  }
}

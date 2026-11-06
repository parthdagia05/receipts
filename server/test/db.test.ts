import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, isDatabaseReachable, openDatabase } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { appliedMigrations, runMigrations } from '../src/db/migrate.js';
import type { Migration } from '../src/db/migrate.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';

describe('openDatabase', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
  });

  afterEach(() => {
    db.close();
  });

  it('opens an in-memory database that answers queries', () => {
    expect(isDatabaseReachable(db)).toBe(true);
  });

  it('enables foreign key enforcement', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('creates missing parent directories for a file database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipts-db-'));
    try {
      const nested = join(dir, 'deeply', 'nested', 'receipts.db');
      const fileDb = openDatabase(nested);

      expect(isDatabaseReachable(fileDb)).toBe(true);
      fileDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isDatabaseReachable', () => {
  it('reports false for a closed database instead of throwing', () => {
    const db = openDatabase(IN_MEMORY);
    db.close();

    expect(isDatabaseReachable(db)).toBe(false);
  });
});

describe('runMigrations', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
  });

  afterEach(() => {
    db.close();
  });

  it('creates the ledger and applies nothing when there are no migrations', () => {
    expect(runMigrations(db, [])).toEqual([]);
    expect(appliedMigrations(db)).toEqual([]);
  });

  it('applies the project migration list without error', () => {
    // Empty for this chunk; this asserts the wiring, not a particular schema.
    expect(runMigrations(db)).toEqual([...MIGRATIONS].map((m) => m.id));
  });

  it('applies migrations in id order and records them', () => {
    const migrations: Migration[] = [
      { id: '002_second', sql: 'CREATE TABLE second (id INTEGER PRIMARY KEY) STRICT;' },
      { id: '001_first', sql: 'CREATE TABLE first (id INTEGER PRIMARY KEY) STRICT;' },
    ];

    expect(runMigrations(db, migrations)).toEqual(['001_first', '002_second']);
    expect(appliedMigrations(db)).toEqual(['001_first', '002_second']);
  });

  it('is idempotent across repeated runs', () => {
    const migrations: Migration[] = [
      { id: '001_first', sql: 'CREATE TABLE first (id INTEGER PRIMARY KEY) STRICT;' },
    ];

    expect(runMigrations(db, migrations)).toEqual(['001_first']);
    expect(runMigrations(db, migrations)).toEqual([]);
    expect(appliedMigrations(db)).toEqual(['001_first']);
  });

  it('applies only the migrations added since the last run', () => {
    const first: Migration[] = [
      { id: '001_first', sql: 'CREATE TABLE first (id INTEGER PRIMARY KEY) STRICT;' },
    ];
    runMigrations(db, first);

    const both: Migration[] = [
      ...first,
      { id: '002_second', sql: 'CREATE TABLE second (id INTEGER PRIMARY KEY) STRICT;' },
    ];

    expect(runMigrations(db, both)).toEqual(['002_second']);
    expect(appliedMigrations(db)).toEqual(['001_first', '002_second']);
  });

  it('rolls a failed migration back and leaves it unrecorded', () => {
    const migrations: Migration[] = [
      {
        id: '001_broken',
        sql: `
          CREATE TABLE good (id INTEGER PRIMARY KEY) STRICT;
          CREATE TABLE bad (this is not valid sql);
        `,
      },
    ];

    expect(() => runMigrations(db, migrations)).toThrow();
    expect(appliedMigrations(db)).toEqual([]);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'good'")
      .all();
    expect(tables).toEqual([]);
  });

  it('rejects a duplicate migration id', () => {
    const migrations: Migration[] = [
      { id: '001_dup', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT;' },
      { id: '001_dup', sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT;' },
    ];

    expect(() => runMigrations(db, migrations)).toThrow(/Duplicate migration id: 001_dup/);
  });
});

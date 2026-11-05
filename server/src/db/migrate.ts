import type { Db } from './index.js';
import { MIGRATIONS } from './migrations/index.js';

/** One forward-only schema change, applied in `id` order. */
export interface Migration {
  /** Sortable, immutable identifier, e.g. `001_challenges`. */
  readonly id: string;
  /** Statements to apply. Runs inside a transaction. */
  readonly sql: string;
}

const MIGRATIONS_TABLE = 'schema_migrations';

/**
 * Create the ledger that records which migrations have run.
 *
 * Separate from the migrations themselves: the ledger is infrastructure, so it
 * must exist before the first migration can be recorded.
 */
function ensureLedger(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id          TEXT PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    ) STRICT;
  `);
}

/** Ids already recorded as applied. */
export function appliedMigrations(db: Db): string[] {
  ensureLedger(db);
  const rows = db.prepare(`SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id`).all() as {
    id: string;
  }[];
  return rows.map((r) => r.id);
}

/**
 * Apply every migration not yet recorded, in `id` order.
 *
 * Each migration and its ledger row commit together, so an interrupted run
 * leaves the database on a migration boundary rather than part-way through one.
 * Re-running is a no-op, which is what makes it safe to call on every boot.
 *
 * @param db Open database.
 * @param migrations Defaults to the project's migration list; tests pass their own.
 * @returns The ids applied by this call, in order.
 */
export function runMigrations(db: Db, migrations: readonly Migration[] = MIGRATIONS): string[] {
  ensureLedger(db);

  const ids = migrations.map((m) => m.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) {
    throw new Error(`Duplicate migration id: ${duplicate}`);
  }

  const isApplied = db.prepare(`SELECT 1 FROM ${MIGRATIONS_TABLE} WHERE id = ?`);
  const record = db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (id, applied_at) VALUES (?, ?)`);

  const applied: string[] = [];
  for (const migration of [...migrations].sort((a, b) => a.id.localeCompare(b.id))) {
    if (isApplied.get(migration.id) !== undefined) continue;

    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id, Date.now());
    })();

    applied.push(migration.id);
  }

  return applied;
}

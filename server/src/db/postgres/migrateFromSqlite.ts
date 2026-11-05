import Database from 'better-sqlite3';
import type { PgPool } from './pool.js';
import { applySchema } from './pool.js';

/**
 * Copy a SQLite database into PostgreSQL.
 *
 * Three properties govern the implementation:
 *
 *   The source is NEVER modified. It is opened `readonly`, so a bug here
 *   cannot damage the only copy of the data. SQLite would reject a write
 *   even if one were attempted.
 *
 *   Reruns are safe. Every insert is `ON CONFLICT DO NOTHING`, so a partial
 *   run can simply be repeated. The report distinguishes rows inserted from
 *   rows already present, so a rerun is visibly a no-op rather than silently
 *   looking like a fresh migration.
 *
 *   Nothing is discarded silently. A row that cannot be inserted is recorded
 *   with its table, key and the driver's message. The caller decides whether
 *   to proceed; this function does not swallow the decision.
 *
 * Insert order follows the foreign keys — requests, then verifications, then
 * authorizations — because `world_id_verifications.nonce` references
 * `world_id_requests.nonce` and `review_authorizations.verification_nonce`
 * references that in turn. Inserting out of order would fail every child row.
 */

export interface TableReport {
  readonly table: string;
  /** Rows found in SQLite. */
  readonly source: number;
  /** Rows this run inserted. */
  readonly inserted: number;
  /** Rows already present, so skipped. A rerun makes this the whole count. */
  readonly skipped: number;
  /** Rows that could not be inserted, with why. */
  readonly failures: readonly { readonly key: string; readonly error: string }[];
}

export interface MigrationReport {
  readonly tables: readonly TableReport[];
  /** True when every source row is now present in PostgreSQL. */
  readonly complete: boolean;
  readonly totalSource: number;
  readonly totalInserted: number;
  readonly totalFailed: number;
}

/** Tables in foreign-key order. */
const TABLES = [
  'world_id_requests',
  'world_id_verifications',
  'review_authorizations',
  'wallet_review_authorizations',
  'review_contents',
] as const;

type TableName = (typeof TABLES)[number];

const COLUMNS: Record<TableName, readonly string[]> = {
  world_id_requests: [
    'nonce',
    'rp_id',
    'action',
    'agent_id',
    'created_at',
    'expires_at',
    'consumed_at',
  ],
  world_id_verifications: [
    'nonce',
    'agent_id',
    'reviewer',
    'nullifier',
    'verified_at',
    'authorized_at',
  ],
  review_authorizations: [
    'nonce',
    'verification_nonce',
    'agent_id',
    'reviewer',
    'nullifier',
    'value',
    'value_decimals',
    'feedback_hash',
    'review_type',
    'receipt_id',
    'deadline',
    'created_at',
    'consumed_at',
    'signature',
  ],
  wallet_review_authorizations: [
    'nonce',
    'agent_id',
    'reviewer',
    'nullifier',
    'value',
    'value_decimals',
    'feedback_hash',
    'review_type',
    'receipt_id',
    'deadline',
    'created_at',
    'consumed_at',
    'signature',
  ],
  review_contents: ['feedback_hash', 'content', 'created_at'],
};

/** Primary key, used only to identify a row in a failure report. */
const KEY: Record<TableName, string> = {
  world_id_requests: 'nonce',
  world_id_verifications: 'nonce',
  review_authorizations: 'nonce',
  wallet_review_authorizations: 'nonce',
  review_contents: 'feedback_hash',
};

export interface MigrateOptions {
  /** Path to the SQLite file. Opened read-only. */
  readonly sqlitePath: string;
  readonly pool: PgPool;
  /** Apply the PostgreSQL schema first. Default true. */
  readonly ensureSchema?: boolean;
}

export async function migrateFromSqlite(options: MigrateOptions): Promise<MigrationReport> {
  if (options.ensureSchema !== false) {
    await applySchema(options.pool);
  }

  // `readonly` is the guarantee that matters: the source is the only copy of
  // this data and nothing here may write to it.
  const sqlite = new Database(options.sqlitePath, { readonly: true, fileMustExist: true });

  try {
    const reports: TableReport[] = [];

    for (const table of TABLES) {
      reports.push(await copyTable(sqlite, options.pool, table));
    }

    const totalSource = reports.reduce((sum, r) => sum + r.source, 0);
    const totalInserted = reports.reduce((sum, r) => sum + r.inserted, 0);
    const totalFailed = reports.reduce((sum, r) => sum + r.failures.length, 0);

    return {
      tables: reports,
      // Complete means every source row is accounted for as inserted or
      // already present -- not merely that the run finished.
      complete: totalFailed === 0,
      totalSource,
      totalInserted,
      totalFailed,
    };
  } finally {
    sqlite.close();
  }
}

async function copyTable(
  sqlite: Database.Database,
  pool: PgPool,
  table: TableName,
): Promise<TableReport> {
  const columns = COLUMNS[table];
  const keyColumn = KEY[table];

  // A table absent from an older SQLite file is not an error: the source may
  // predate a migration. It is reported as zero rows.
  const exists = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (exists === undefined) {
    return { table, source: 0, inserted: 0, skipped: 0, failures: [] };
  }

  const rows = sqlite.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all() as Record<
    string,
    unknown
  >[];

  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
               ON CONFLICT (${keyColumn}) DO NOTHING`;

  let inserted = 0;
  let skipped = 0;
  const failures: { key: string; error: string }[] = [];

  for (const row of rows) {
    const values = columns.map((column) => {
      const value = row[column];
      // SQLite BLOB arrives as a Buffer and maps straight onto BYTEA.
      // Everything else is TEXT or INTEGER and needs no conversion: pg
      // accepts a JS number for BIGINT.
      return value instanceof Uint8Array ? Buffer.from(value) : value;
    });

    try {
      const result = await pool.query(sql, values);
      if ((result.rowCount ?? 0) > 0) inserted += 1;
      else skipped += 1;
    } catch (error) {
      failures.push({
        key: String(row[keyColumn]),
        // The driver's message names the constraint, which is what a reader
        // needs. It carries no connection string.
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { table, source: rows.length, inserted, skipped, failures };
}

/** A human-readable summary, for the CLI and for logs. */
export function formatReport(report: MigrationReport): string {
  const lines = [
    `source rows   ${report.totalSource}`,
    `inserted      ${report.totalInserted}`,
    `failed        ${report.totalFailed}`,
    '',
  ];
  for (const table of report.tables) {
    lines.push(
      `  ${table.table.padEnd(24)} source=${table.source} inserted=${table.inserted} already=${table.skipped} failed=${table.failures.length}`,
    );
    for (const failure of table.failures) {
      lines.push(`      ${failure.key}: ${failure.error}`);
    }
  }
  lines.push('', report.complete ? 'COMPLETE' : 'INCOMPLETE — see failures above');
  return lines.join('\n');
}

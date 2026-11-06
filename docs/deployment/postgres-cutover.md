# SQLite → PostgreSQL cutover

The exact procedure. The source database is never written to, and no data is
migrated automatically at startup.

## 1. What startup does and does not do

On boot with `DATABASE_DRIVER=postgres`, the server:

- applies the schema (`applySchema`), which is idempotent and guarded by a
  PostgreSQL advisory lock so two tasks starting together apply it once;
- **exits non-zero** if the database is unreachable.

It does **not** copy any data. Migration is a deliberate, separate operation,
run by a person who can read its report.

## 2. Procedure

```bash
# 0. Stop writers. Migrating under a live server gives a torn copy.
docker compose -f docker-compose.prod.yml stop api

# 1. Back up the source. It is never written to, but a backup costs nothing.
cp server/data/receipts.db "receipts-$(date -u +%Y%m%dT%H%M%SZ).db.bak"

# 2. Dry run against a scratch database first.
createdb receipts_cutover_check
DATABASE_URL=postgres://user@localhost:5432/receipts_cutover_check \
  node --input-type=module -e "
    import { createPool } from './dist/db/postgres/pool.js';
    import { migrateFromSqlite, formatReport } from './dist/db/postgres/migrateFromSqlite.js';
    const pool = createPool({ connectionString: process.env.DATABASE_URL });
    const report = await migrateFromSqlite({ sqlitePath: './data/receipts.db', pool });
    console.log(formatReport(report));
    await pool.end();
    process.exit(report.complete ? 0 : 1);
  "

# 3. Read the report. It prints, per table:
#       source=   rows found in SQLite
#       inserted= rows this run wrote
#       already=  rows already present (a rerun makes this the whole count)
#       failed=   rows that could NOT be inserted, each with its key and reason
#
#    It exits non-zero unless every source row is accounted for. Nothing is
#    skipped silently.

# 4. Repeat against the real database once the dry run is COMPLETE.

# 5. Switch the driver and restart.
#      DATABASE_DRIVER=postgres
#      DATABASE_URL=postgres://...
docker compose -f docker-compose.prod.yml up -d api
curl -fsS http://127.0.0.1:8080/health
```

Reruns are safe: every insert is `ON CONFLICT DO NOTHING`, so a partial run
is repeated rather than unwound.

## 3. Rollback

The SQLite database is untouched and still authoritative until the cutover is
accepted, so rollback is a configuration change:

```bash
# .env.prod
DATABASE_DRIVER=sqlite
# unset DATABASE_URL

docker compose -f docker-compose.prod.yml up -d api
```

**Caveat:** rows written to PostgreSQL after the cutover do not exist in
SQLite. Rolling back loses them. Most tables hold state that expires within
300 seconds, so the practical loss is in-flight review journeys; the only
durable table, `review_contents`, is content-addressed and rebuildable from
`ReviewSubmitted` events.

Rolling back is therefore safe during the cutover window and progressively
less so afterwards. If PostgreSQL has been live long enough to hold reviews
worth keeping, restore from a `pg_dump` instead of reverting the driver.

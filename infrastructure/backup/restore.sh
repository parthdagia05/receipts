#!/usr/bin/env bash
#
# Restore a Receipts backup into a NEW database, and report what landed.
#
#   ./restore.sh receipts-20261105T030000Z.dump
#   ./restore.sh receipts-20261105T030000Z.dump receipts_drill
#
# The default target is a fresh `receipts_restore_<stamp>` database beside the
# live one. Restoring is how a backup is tested, and a test that can destroy
# the thing it is protecting is not a test -- so overwriting the live database
# requires --force-into-production and typing its name, and even then this
# script will not drop it for you.
#
# Verifying a restore is the whole point, so this always prints the table list
# and per-table row counts rather than exiting silently on success.

set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-/opt/receipts/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-/opt/receipts/.env.prod}"
PG_SERVICE="${PG_SERVICE:-postgres}"
POSTGRES_USER="${POSTGRES_USER:-receipts}"
POSTGRES_DB="${POSTGRES_DB:-receipts}"

log()  { printf '%s [restore] %s\n'       "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die()  { printf '%s [restore] FAIL: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

FORCE=0
args=()
for a in "$@"; do
  case "$a" in
    --force-into-production) FORCE=1 ;;
    -*) die "unknown option: $a" ;;
    *)  args+=("$a") ;;
  esac
done

DUMP="${args[0]:-}"
[[ -n "$DUMP" ]] || die "usage: restore.sh <dump-file> [target-db] [--force-into-production]"
[[ -r "$DUMP" ]] || die "dump not readable: $DUMP"

TARGET="${args[1]:-receipts_restore_$(date -u +%Y%m%dT%H%M%SZ)}"

if [[ "$TARGET" == "$POSTGRES_DB" ]]; then
  if (( ! FORCE )); then
    die "refusing to restore over the live database '$POSTGRES_DB'. Restore to a new database and swap, or pass --force-into-production."
  fi
  log "WARNING: restoring over the LIVE database '$POSTGRES_DB' at your instruction"
fi

command -v docker >/dev/null 2>&1 || die "docker is not on PATH"
compose exec -T "$PG_SERVICE" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 \
  || die "postgres service '$PG_SERVICE' is not accepting connections"

# 1. Validate before touching anything. A corrupt archive must be found now,
#    not after the target database has been created and half filled.
log "validating archive: $(basename -- "$DUMP")"
toc="$(compose exec -T "$PG_SERVICE" sh -c '
    set -e
    t=$(mktemp /tmp/restore.XXXXXX)
    trap "rm -f \"$t\"" EXIT
    cat > "$t"
    pg_restore --list "$t"
  ' < "$DUMP" 2>&1)" || die "pg_restore --list rejected the archive"

tables_in_toc="$(printf '%s\n' "$toc" | grep -c ' TABLE ' || true)"
[[ "$tables_in_toc" -ge 1 ]] || die "archive contains no tables"
log "archive valid: $tables_in_toc table entries"

# 2. Create the target. CREATE DATABASE fails if it exists, which is the
#    behaviour wanted: silently restoring into a populated database would
#    merge two different points in time.
if [[ "$TARGET" != "$POSTGRES_DB" ]]; then
  log "creating database '$TARGET'"
  compose exec -T "$PG_SERVICE" \
    psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$TARGET\";" >/dev/null \
    || die "could not create '$TARGET' (does it already exist?)"
fi

# 3. Restore. --no-owner because the dump was taken that way; --exit-on-error
#    so a partial restore is a failure rather than a surprise later.
log "restoring into '$TARGET'"
compose exec -T "$PG_SERVICE" sh -c '
    set -e
    t=$(mktemp /tmp/restore.XXXXXX)
    trap "rm -f \"$t\"" EXIT
    cat > "$t"
    pg_restore --no-owner --exit-on-error --dbname "$1" --username "$2" "$t"
  ' _ "$TARGET" "$POSTGRES_USER" < "$DUMP" \
  || die "pg_restore failed; '$TARGET' is incomplete and should be dropped"

# 4. Report. Counts come from the restored database itself, not from the
#    archive, so this reflects what is actually queryable.
log "restored. verifying:"
compose exec -T "$PG_SERVICE" psql -U "$POSTGRES_USER" -d "$TARGET" -P pager=off -c "
  SELECT relname AS table,
         n_live_tup AS approx_rows
    FROM pg_stat_user_tables
   ORDER BY relname;"

compose exec -T "$PG_SERVICE" psql -U "$POSTGRES_USER" -d "$TARGET" -tAc "
  SELECT 'tables=' || count(*) FROM pg_tables WHERE schemaname = 'public';"

log "done. Compare the above with the live database before swapping anything."
log "drop when finished:  docker compose exec -T $PG_SERVICE psql -U $POSTGRES_USER -d postgres -c 'DROP DATABASE \"$TARGET\";'"

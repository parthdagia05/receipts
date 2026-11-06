#!/usr/bin/env bash
#
# Nightly logical backup of the Receipts PostgreSQL database.
#
#   ./backup.sh
#
# Configuration comes from the environment (see backup.env.example). Every
# value has a default that is correct for the EC2 layout, so a plain run on
# the instance needs no arguments.
#
# The ordering is the point of this script: a dump is written to a temporary
# file, verified, and only then given its final name. A file named
# `receipts-<stamp>.dump` in the backup directory has therefore passed
# `pg_restore --list`. Retention only ever considers those, so a run that
# fails can never cause an older good backup to be deleted.
#
# Passwords: there are none to leak. `pg_dump` runs INSIDE the postgres
# container over its local socket, which the official image trusts, so no
# credential is passed on a command line (visible in `ps`), in an environment
# variable, or in a log line. The database password never enters this script.

set -Eeuo pipefail

# --- configuration ---------------------------------------------------------

COMPOSE_FILE="${COMPOSE_FILE:-/opt/receipts/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-/opt/receipts/.env.prod}"
PG_SERVICE="${PG_SERVICE:-postgres}"

POSTGRES_USER="${POSTGRES_USER:-receipts}"
POSTGRES_DB="${POSTGRES_DB:-receipts}"

BACKUP_DIR="${BACKUP_DIR:-/opt/receipts/backups}"

# Empty disables the upload and leaves a local-only backup. That is a
# supported mode -- it is what runs before the bucket exists -- but it is
# reported loudly, because a backup on the same instance as the database
# protects against almost nothing.
S3_BUCKET="${S3_BUCKET:-}"
S3_PREFIX="${S3_PREFIX:-postgres}"

# Local retention. S3 retention is the bucket's lifecycle rule, not this:
# the instance deliberately has no permission to delete anything in S3.
RETENTION_DAYS="${RETENTION_DAYS:-7}"

# The floor that makes "never delete the only valid backup" true regardless
# of RETENTION_DAYS. If a backup has not succeeded for a fortnight, the last
# good ones are what is left, and age is the wrong reason to remove them.
RETENTION_MIN_KEEP="${RETENTION_MIN_KEEP:-3}"

LOCK_DIR="${LOCK_DIR:-/var/lock/receipts-backup.lock}"

readonly PREFIX='receipts-'
readonly SUFFIX='.dump'

# --- logging ---------------------------------------------------------------
#
# stdout and stderr both go to the journal under the unit name. Nothing here
# interpolates a credential; the only variables logged are paths and counts.

log()  { printf '%s [backup] %s\n'       "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
warn() { printf '%s [backup] WARN: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
# `trap - ERR` first: without it bash runs the ERR trap for this function's
# own `exit 1`, so every deliberate failure printed a second, misleading
# line blaming the line number inside die() rather than the real cause.
die()  { trap - ERR; printf '%s [backup] FAIL: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }

# --- cleanup ---------------------------------------------------------------

TMP_DUMP=''
HOLD_LOCK=0

cleanup() {
  local status=$?
  [[ -n "$TMP_DUMP" && -e "$TMP_DUMP" ]] && rm -f -- "$TMP_DUMP"
  # rm -r, not rmdir: the lock directory holds the pid file, so rmdir would
  # fail and leak the lock to every later run. Guarded on HOLD_LOCK so a run
  # that did not take the lock can never remove someone else's.
  if (( HOLD_LOCK )) && [[ -n "$LOCK_DIR" && -d "$LOCK_DIR" ]]; then
    rm -rf -- "$LOCK_DIR"
  fi
  return "$status"
}
trap cleanup EXIT

# `set -E` plus this makes the failing line visible even inside a function.
trap 'die "aborted at line $LINENO"' ERR

# --- overlap prevention ----------------------------------------------------
#
# systemd will not run two instances of a oneshot unit concurrently, so this
# is for manual runs and for a second timer someone adds later. `mkdir` is
# atomic on every filesystem this can land on, unlike a test-then-touch.
#
# A lock left behind by a killed process is detected by its recorded PID
# rather than by age: a stale lock must not survive to block the next night's
# backup, and a slow-but-alive backup must not be trampled.

acquire_lock() {
  if mkdir -- "$LOCK_DIR" 2>/dev/null; then
    HOLD_LOCK=1
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return 0
  fi

  local holder=''
  [[ -r "$LOCK_DIR/pid" ]] && holder="$(cat -- "$LOCK_DIR/pid" 2>/dev/null || true)"

  if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then
    die "another backup is running (pid $holder); not starting a second"
  fi

  warn "removing a stale lock left by pid ${holder:-unknown}"
  rm -rf -- "$LOCK_DIR"
  mkdir -- "$LOCK_DIR" || die "could not take the lock at $LOCK_DIR"
  HOLD_LOCK=1
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
}

# --- helpers ---------------------------------------------------------------

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

preflight() {
  command -v docker >/dev/null 2>&1 || die "docker is not on PATH"
  [[ -r "$COMPOSE_FILE" ]] || die "compose file not readable: $COMPOSE_FILE"
  [[ -r "$ENV_FILE" ]]     || die "env file not readable: $ENV_FILE"

  mkdir -p -- "$BACKUP_DIR" || die "cannot create $BACKUP_DIR"
  [[ -w "$BACKUP_DIR" ]]    || die "backup directory is not writable: $BACKUP_DIR"

  # A dump taken from a container that is up but not accepting connections
  # fails anyway; failing here says why.
  compose exec -T "$PG_SERVICE" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 \
    || die "postgres service '$PG_SERVICE' is not accepting connections"

  if [[ -n "$S3_BUCKET" ]]; then
    command -v aws >/dev/null 2>&1 || die "S3_BUCKET is set but the aws CLI is not installed"
  fi
}

# Verify the archive by handing it back to pg_restore. `--list` parses the
# whole table of contents, so a truncated or corrupt file fails here rather
# than at 3am on the night it is needed.
#
# A readable-but-empty archive also fails: a dump of nothing is a valid
# custom-format file, and promoting one would quietly replace a real backup
# with an empty one.
verify_archive() {
  local file="$1" toc tables

  toc="$(compose exec -T "$PG_SERVICE" sh -c '
      set -e
      t=$(mktemp /tmp/verify.XXXXXX)
      trap "rm -f \"$t\"" EXIT
      cat > "$t"
      pg_restore --list "$t"
    ' < "$file" 2>&1)" || return 1

  tables="$(printf '%s\n' "$toc" | grep -c ' TABLE ' || true)"
  [[ "$tables" -ge 1 ]] || { warn "archive lists no tables"; return 1; }

  log "archive verified: $tables table entries in the table of contents"
  return 0
}

upload() {
  local file="$1" name
  name="$(basename -- "$file")"

  if [[ -z "$S3_BUCKET" ]]; then
    warn "S3_BUCKET is unset; the backup exists only on this instance"
    return 0
  fi

  # --only-show-errors so a success is one log line, not a progress bar.
  # Server-side encryption is enforced by the bucket policy; it is passed
  # here too so a misconfigured bucket fails loudly instead of storing an
  # unencrypted object.
  if aws s3 cp --only-show-errors --sse aws:kms \
       -- "$file" "s3://${S3_BUCKET}/${S3_PREFIX}/${name}"; then
    log "uploaded to s3://${S3_BUCKET}/${S3_PREFIX}/${name}"
    return 0
  fi

  return 1
}

# Delete verified backups older than RETENTION_DAYS, but never the newest
# RETENTION_MIN_KEEP, and never anything unless a fresh backup has just
# succeeded. Only files matching the final naming convention are considered,
# so a partial file from a crashed run is not a candidate and is not counted
# as one of the survivors either.
prune() {
  local -a dumps=()
  local f

  while IFS= read -r f; do
    [[ -n "$f" ]] && dumps+=("$f")
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f \
             -name "${PREFIX}*${SUFFIX}" -print 2>/dev/null | LC_ALL=C sort -r)

  local total=${#dumps[@]}

  # Hard floor of 1, whatever the configuration says. "Never delete the only
  # valid backup" has to survive someone setting RETENTION_MIN_KEEP=0 in
  # backup.env, which is exactly the sort of change that gets made at 2am to
  # free disk space and is not noticed until it matters.
  local keep="$RETENTION_MIN_KEEP"
  if (( keep < 1 )); then
    warn "RETENTION_MIN_KEEP=$RETENTION_MIN_KEEP would permit deleting every backup; using 1"
    keep=1
  fi

  log "retention: $total verified backup(s) on disk, keeping the newest $keep and anything under ${RETENTION_DAYS}d"

  if (( total <= keep )); then
    log "retention: nothing to consider"
    return 0
  fi

  local removed=0 i
  for (( i = keep; i < total; i++ )); do
    f="${dumps[$i]}"
    # -mtime +N is "strictly more than N days", which is what is wanted:
    # a file from exactly RETENTION_DAYS ago is kept.
    if [[ -n "$(find "$f" -maxdepth 0 -mtime "+${RETENTION_DAYS}" -print 2>/dev/null)" ]]; then
      rm -f -- "$f" && removed=$(( removed + 1 ))
      log "retention: removed $(basename -- "$f")"
    fi
  done

  log "retention: removed $removed, kept $(( total - removed ))"

  # Belt and braces. If this ever trips, the loop above has a bug and the
  # right outcome is a loud failure, not a silent empty backup directory.
  if (( total - removed < 1 )); then
    die "retention removed every backup; this is a bug"
  fi
}

# --- main ------------------------------------------------------------------

main() {
  acquire_lock
  preflight

  local stamp final
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  final="${BACKUP_DIR}/${PREFIX}${stamp}${SUFFIX}"

  # The temporary file is created in BACKUP_DIR so the promotion below is a
  # rename within one filesystem, which is atomic. A dump written to /tmp and
  # moved across devices is a copy, and a copy can be interrupted halfway.
  TMP_DUMP="$(mktemp "${BACKUP_DIR}/.${PREFIX}${stamp}.XXXXXX")"
  chmod 600 "$TMP_DUMP"

  log "dumping ${POSTGRES_DB} from service '${PG_SERVICE}'"
  if ! compose exec -T "$PG_SERVICE" \
        pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        --format=custom --no-owner > "$TMP_DUMP"; then
    die "pg_dump failed; no backup was promoted and nothing was pruned"
  fi

  local size
  size="$(wc -c < "$TMP_DUMP" | tr -d '[:space:]')"
  [[ "$size" -gt 0 ]] || die "pg_dump produced an empty file"
  log "dump written: ${size} bytes"

  if ! verify_archive "$TMP_DUMP"; then
    die "archive verification failed; the dump was discarded and nothing was pruned"
  fi

  # Promote. From here the file is a backup, and the trap must not delete it.
  mv -- "$TMP_DUMP" "$final"
  TMP_DUMP=''
  chmod 600 "$final"
  log "promoted $(basename -- "$final")"

  # An upload failure is a real failure -- the run exits nonzero so the timer
  # reports it -- but the verified local copy is kept and retention still
  # runs, because deleting it would make a bad night worse.
  local upload_ok=1
  upload "$final" || upload_ok=0

  prune

  if (( upload_ok )); then
    log "backup complete: $(basename -- "$final")"
  else
    die "backup verified locally but the upload failed: $(basename -- "$final")"
  fi
}

# Sourcing the script defines the functions without running a backup, so the
# guards above (verification, retention) can be exercised directly by tests
# rather than only through a full run against a live database.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi

#!/usr/bin/env bash
#
# Deploy one image tag, with health-gated rollback.
#
#   ./deploy.sh <image-tag>
#
# Delivered to the instance by the deploy workflow over SSM rather than
# embedded in user data, which is capped at 16KB.
#
# The contract:
#
#   exit 0  the candidate is running and healthy
#   exit 1  the candidate failed; the PREVIOUS image is running and healthy
#   exit 2  the candidate failed AND the rollback failed -- the service is
#           down and needs a human
#
# Three distinct codes because "deploy failed" and "deploy failed and we
# could not get back" are different incidents, and a workflow that reports
# both as red teaches people to ignore red.

set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/receipts}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.prod}"

# Bounded polling, not a fixed sleep. The old `sleep 15` was shorter than the
# API's own 20s healthcheck start period, and startup includes an on-chain
# signer verification over RPC -- so a slow RPC failed a good deploy, and a
# fast failure still waited the full 15s.
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-3}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/health}"

log()  { printf '%s [deploy] %s\n'       "$(date -u +%FT%TZ)" "$*"; }
fail() { trap - ERR; printf '%s [deploy] FAIL: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; exit "${2:-1}"; }

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# Read a key from the env file without sourcing it -- sourcing would execute
# whatever is in there and would also pull the secrets into this shell.
env_get() {
  local key="$1"
  sed -n "s/^$key=//p" "$ENV_FILE" | tail -1
}

env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  # Preserve permissions: this file holds the runtime secrets.
  chmod 600 "$tmp"
  if grep -q "^$key=" "$ENV_FILE"; then
    sed "s|^$key=.*|$key=$value|" "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

# Poll until healthy or the budget runs out. Returns 0/1; prints how long it
# took, because "healthy after 4s" and "healthy after 110s" are different
# kinds of healthy.
wait_healthy() {
  # Relative to when polling started, not to script start -- otherwise the
  # reported duration silently includes the pull, and "healthy after 90s"
  # would describe a deploy that was healthy in two.
  local started=$SECONDS
  local deadline=$(( started + HEALTH_TIMEOUT ))
  local attempt=0

  while (( SECONDS < deadline )); do
    attempt=$(( attempt + 1 ))
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      log "healthy after $(( SECONDS - started ))s (${attempt} checks)"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
  done

  log "NOT healthy within ${HEALTH_TIMEOUT}s (${attempt} checks)"
  return 1
}

# Point the stack at a tag and bring the API up on it.
switch_to() {
  local tag="$1"
  env_set IMAGE_TAG "$tag"
  compose pull api || return 1
  compose up -d api || return 1
}

main() {
  local candidate="${1:-}"

  [ -n "$candidate" ] || fail "usage: deploy.sh <image-tag>"
  case "$candidate" in
    latest|local|main|master)
      fail "refusing to deploy moving tag '$candidate': ECR tags are immutable and a rollback must name an exact image" ;;
  esac

  [ -r "$COMPOSE_FILE" ] || fail "compose file not readable: $COMPOSE_FILE"
  [ -r "$ENV_FILE" ]     || fail "env file not readable: $ENV_FILE"

  local previous
  previous="$(env_get IMAGE_TAG)"
  [ -n "$previous" ] || fail "no current IMAGE_TAG in $ENV_FILE; refusing to deploy without a rollback target"

  log "current=$previous candidate=$candidate"

  if [ "$previous" = "$candidate" ]; then
    # Idempotent re-run of the same SHA. Still converge and still verify --
    # the point is that re-running a deploy is safe, not that it is a no-op.
    log "same tag already configured; converging and verifying"
    if switch_to "$candidate" && wait_healthy; then
      log "already on $candidate and healthy"
      return 0
    fi
    fail "stack on $candidate is not healthy; no rollback target differs from it" 2
  fi

  if ! switch_to "$candidate"; then
    log "could not start $candidate; rolling back to $previous"
    if switch_to "$previous" && wait_healthy; then
      log "ROLLED BACK to $previous, healthy"
      return 1
    fi
    fail "ROLLBACK FAILED: neither $candidate nor $previous is healthy" 2
  fi

  if wait_healthy; then
    log "deployed $candidate"
    return 0
  fi

  log "$candidate started but never became healthy; rolling back to $previous"
  if switch_to "$previous" && wait_healthy; then
    log "ROLLED BACK to $previous, healthy"
    return 1
  fi

  fail "ROLLBACK FAILED: neither $candidate nor $previous is healthy" 2
}

# Sourceable, so the helpers above can be tested directly.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi

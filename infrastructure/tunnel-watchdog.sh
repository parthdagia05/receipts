#!/bin/bash
# Keeps https://receipts-8004.pages.dev reachable.
#
# WHAT ACTUALLY FAILS
# The backend and Caddy have been stable for a day; the tunnel is what dies.
# A Quick Tunnel gets deleted server-side while cloudflared keeps running and
# retrying ("Unauthorized: Tunnel not found"), so the process looks healthy in
# `ps` while the hostname is NXDOMAIN and Cloudflare serves 1016 as a raw 530.
# Checking that a process exists therefore proves nothing. This checks the
# public URL, which is the only thing that matches what a visitor sees.
#
# WHY A PAGES DEPLOY IS SOMETIMES NEEDED
# BACKEND_ORIGIN is read by the Pages Function from its environment, and a
# changed secret only takes effect on a new deployment. So a tunnel whose
# hostname changes forces a redeploy. A STATIC ngrok domain removes that
# entirely: set NGROK_DOMAIN and recovery becomes a local process restart with
# no Cloudflare involvement at all. That is the preferred configuration.
#
# THE ARTIFACT GUARD
# An earlier version of this script would have redeployed whatever sat in a
# scratch directory, which at the time was a build without Anon-RPC -- it would
# have silently reverted production on the first tunnel blip. This refuses to
# deploy unless the entry bundle hashes to EXPECTED_ENTRY_SHA256.
#
# Secrets are never logged. BACKEND_ORIGIN is piped to wrangler on stdin.

set -uo pipefail

PUBLIC_URL=${PUBLIC_URL:-https://receipts-8004.pages.dev}
LOCAL_HEALTH=${LOCAL_HEALTH:-http://localhost/health}
PROJECT=${PROJECT:-receipts-8004}
DEPLOY_DIR=${DEPLOY_DIR:-/Users/parthdagia/receipt-qa/deploy/cloudflare-pages}
SITE_DIR=${SITE_DIR:?SITE_DIR is required (the verified production artifact)}
# sha256 of the entry bundle this script is allowed to deploy.
EXPECTED_ENTRY_SHA256=${EXPECTED_ENTRY_SHA256:?EXPECTED_ENTRY_SHA256 is required}
COMMIT_HASH=${COMMIT_HASH:-a48f587}

# Set this to a claimed ngrok static domain to avoid Cloudflare deploys.
NGROK_DOMAIN=${NGROK_DOMAIN:-}

STATE_DIR=${STATE_DIR:-/Users/parthdagia/.local/state/receipts-watchdog}
LOG="$STATE_DIR/watchdog.log"
LOCK="$STATE_DIR/watchdog.lock"
URLFILE="$STATE_DIR/tunnel-url.txt"
NGROK_LOG="$STATE_DIR/ngrok.log"

INTERVAL=${INTERVAL:-30}
FAILS_BEFORE_ACTION=${FAILS_BEFORE_ACTION:-2}
MAX_RECOVERIES_PER_HOUR=${MAX_RECOVERIES_PER_HOUR:-6}

mkdir -p "$STATE_DIR"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# One instance. macOS has no flock; mkdir is atomic. A lock whose recorded pid
# is gone (kill -9, reboot) is cleared rather than blocking forever.
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && kill -0 "$(cat "$LOCK/pid")" 2>/dev/null; then
    echo "watchdog already running (pid $(cat "$LOCK/pid"))" >&2
    exit 1
  fi
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || { echo "could not acquire lock" >&2; exit 1; }
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT INT TERM

# --- checks ----------------------------------------------------------------

# 200 AND JSON. The 1016 failure returns a 200-shaped edge page in some
# variants, and an ngrok interstitial is a 200 text/html, so status alone is
# not enough to call the backend reachable.
public_healthy() {
  local out code ctype
  out=$(curl -sS -m 20 -o /tmp/wd.$$ -w '%{http_code} %{content_type}' "$PUBLIC_URL/health" 2>/dev/null)
  code=${out%% *}; ctype=${out#* }
  rm -f /tmp/wd.$$
  [ "$code" = "200" ] && case "$ctype" in application/json*) return 0;; esac
  LAST_REASON="public /health -> http=$code ctype=$ctype"
  return 1
}

local_healthy() {
  [ "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$LOCAL_HEALTH" 2>/dev/null)" = "200" ]
}

tunnel_healthy() {
  local url; url=$(cat "$URLFILE" 2>/dev/null)
  [ -n "$url" ] || return 1
  [ "$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$url/health" 2>/dev/null)" = "200" ]
}

ngrok_running() { pgrep -f 'ngrok http' >/dev/null 2>&1; }

# --- recovery ---------------------------------------------------------------

start_ngrok() {
  pkill -f 'ngrok http' 2>/dev/null
  sleep 2
  : > "$NGROK_LOG"
  if [ -n "$NGROK_DOMAIN" ]; then
    nohup ngrok http 80 --url="$NGROK_DOMAIN" --log=stdout --log-format=logfmt >> "$NGROK_LOG" 2>&1 &
  else
    nohup ngrok http 80 --log=stdout --log-format=logfmt >> "$NGROK_LOG" 2>&1 &
  fi

  local url=''
  for _ in $(seq 1 20); do
    sleep 2
    url=$(curl -sS -m 5 http://127.0.0.1:4040/api/tunnels 2>/dev/null \
      | sed -n 's/.*"public_url":"\(https:[^"]*\)".*/\1/p' | head -1)
    [ -n "$url" ] && break
  done
  [ -n "$url" ] || { log "RECOVER FAIL: ngrok produced no URL"; return 1; }

  if ! curl -sS -m 15 -o /dev/null -w '%{http_code}' "$url/health" 2>/dev/null | grep -q 200; then
    log "RECOVER FAIL: $url/health did not return 200"
    return 1
  fi

  echo "$url" > "$URLFILE"
  log "RECOVER: tunnel up at $url"
  return 0
}

# Refuse to ship anything but the artifact this watchdog was pinned to.
artifact_ok() {
  local f actual
  f=$(ls "$SITE_DIR"/assets/index-*.js 2>/dev/null | head -1)
  [ -n "$f" ] || { log "ARTIFACT FAIL: no entry bundle in $SITE_DIR"; return 1; }
  actual=$(shasum -a 256 "$f" | cut -d' ' -f1)
  if [ "$actual" != "$EXPECTED_ENTRY_SHA256" ]; then
    log "ARTIFACT FAIL: $(basename "$f") sha=$actual expected=$EXPECTED_ENTRY_SHA256 -- refusing to deploy"
    return 1
  fi
  return 0
}

update_backend_origin() {
  local url=$1
  artifact_ok || return 1

  if ! printf '%s' "$url" | (cd "$DEPLOY_DIR" && npx --yes wrangler@4.158.0 pages secret put BACKEND_ORIGIN \
        --project-name "$PROJECT" >>"$LOG" 2>&1); then
    log "RECOVER FAIL: could not set BACKEND_ORIGIN"
    return 1
  fi

  if ! (cd "$DEPLOY_DIR" && npx --yes wrangler@4.158.0 pages deploy "$SITE_DIR" \
        --project-name "$PROJECT" --branch main --commit-hash "$COMMIT_HASH" --commit-dirty=true \
        --commit-message "watchdog: tunnel rotated" >>"$LOG" 2>&1); then
    log "RECOVER FAIL: pages deploy failed"
    return 1
  fi
  log "RECOVER: BACKEND_ORIGIN updated and redeployed"
  return 0
}

recover() {
  local previous; previous=$(cat "$URLFILE" 2>/dev/null)
  start_ngrok || return 1
  local current; current=$(cat "$URLFILE" 2>/dev/null)

  if [ -n "$NGROK_DOMAIN" ] && [ "$current" = "$previous" ]; then
    log "RECOVER: static domain unchanged -- no Cloudflare deploy needed"
  elif [ "$current" = "$previous" ]; then
    log "RECOVER: hostname unchanged -- no Cloudflare deploy needed"
  else
    update_backend_origin "$current" || return 1
  fi

  # Declare success only after the public URL agrees.
  for _ in $(seq 1 10); do
    sleep 5
    if public_healthy; then log "RECOVER OK: $PUBLIC_URL healthy"; return 0; fi
  done
  log "RECOVER INCOMPLETE: $PUBLIC_URL still unhealthy (${LAST_REASON:-unknown})"
  return 1
}

# --- loop -------------------------------------------------------------------

log "watchdog started (pid $$, interval ${INTERVAL}s, static_domain=${NGROK_DOMAIN:-none})"
log "pinned artifact sha256=$EXPECTED_ENTRY_SHA256 from $SITE_DIR"

fails=0
backoff=0
recoveries=0
window_start=$(date +%s)

while true; do
  now=$(date +%s)
  if [ $((now - window_start)) -ge 3600 ]; then
    [ "$recoveries" -gt 0 ] && log "rate window reset (${recoveries} recoveries last hour)"
    window_start=$now; recoveries=0
  fi

  # A local outage is not a tunnel fault. Rotating would not fix it and would
  # burn a deployment, so it is logged and waited out.
  if ! local_healthy; then
    log "local stack unhealthy ($LOCAL_HEALTH) -- not touching the tunnel"
    fails=0
    sleep "$INTERVAL"; continue
  fi

  if public_healthy; then
    [ "$fails" -gt 0 ] && log "recovered on its own; public healthy"
    fails=0; backoff=0
    sleep "$INTERVAL"; continue
  fi

  fails=$((fails + 1))
  reason="${LAST_REASON:-unknown}"
  ngrok_running || reason="$reason; ngrok process absent"
  tunnel_healthy || reason="$reason; tunnel URL unhealthy"
  log "health check failed ($fails/$FAILS_BEFORE_ACTION): $reason"

  if [ "$fails" -ge "$FAILS_BEFORE_ACTION" ]; then
    if [ "$recoveries" -ge "$MAX_RECOVERIES_PER_HOUR" ]; then
      log "rate limit reached ($MAX_RECOVERIES_PER_HOUR/hour) -- holding, manual attention needed"
      sleep 300; continue
    fi
    recoveries=$((recoveries + 1))
    log "attempting recovery ${recoveries}/${MAX_RECOVERIES_PER_HOUR} this hour"
    if recover; then
      fails=0; backoff=0
    else
      backoff=$(( backoff == 0 ? 60 : backoff * 2 ))
      [ "$backoff" -gt 600 ] && backoff=600
      log "recovery failed; backing off ${backoff}s"
      sleep "$backoff"
    fi
  fi

  sleep "$INTERVAL"
done

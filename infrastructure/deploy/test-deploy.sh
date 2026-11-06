#!/usr/bin/env bash
#
# Regression tests for deploy.sh. No AWS, no Docker, no network: `docker`
# and `curl` are replaced by stubs on PATH whose behaviour is driven by
# environment variables, so every branch -- including the ones that only
# happen during an outage -- is exercised deterministically.
#
#   ./test-deploy.sh
#
# The stubs read the real .env.prod the script writes, so the assertions are
# about what deploy.sh actually did to that file, not about what it logged.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$HERE/deploy.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()  { echo "    PASS  $*"; pass=$((pass+1)); }
bad() { echo "    FAIL  $*"; fail=$((fail+1)); }
hdr() { echo; echo "=== $* ==="; }

# --- stubs -----------------------------------------------------------------

mkdir -p "$WORK/bin"

cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
# docker compose -f <file> --env-file <env> <cmd> ...
env_file=""
prev=""
for a in "$@"; do
  [ "$prev" = "--env-file" ] && env_file="$a"
  prev="$a"
done
tag="$(sed -n 's/^IMAGE_TAG=//p' "$env_file" | tail -1)"
case " $* " in
  *" pull "*)
    case " ${FAKE_PULL_FAIL:-} " in *" $tag "*) echo "stub: pull $tag failed" >&2; exit 1;; esac ;;
  *" up "*)
    case " ${FAKE_UP_FAIL:-} " in *" $tag "*) echo "stub: up $tag failed" >&2; exit 1;; esac ;;
esac
exit 0
STUB

cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
# Healthy iff the tag currently written to the env file is in FAKE_HEALTHY.
tag="$(sed -n 's/^IMAGE_TAG=//p' "$ENV_FILE" | tail -1)"
case " ${FAKE_HEALTHY:-} " in *" $tag "*) exit 0;; esac
exit 1
STUB

chmod +x "$WORK/bin/docker" "$WORK/bin/curl"
export PATH="$WORK/bin:$PATH"

# --- fixture ---------------------------------------------------------------

setup() {                    # setup <current-tag>
  rm -rf "$WORK/app"; mkdir -p "$WORK/app"
  : > "$WORK/app/docker-compose.prod.yml"
  cat > "$WORK/app/.env.prod" <<EOF
RECORD_SERVER_PRIVATE_KEY=not-a-real-key
ECR_REGISTRY=123456789012.dkr.ecr.ap-southeast-2.amazonaws.com
IMAGE_TAG=$1
POSTGRES_DB=receipts
EOF
  chmod 600 "$WORK/app/.env.prod"
  export APP_DIR="$WORK/app"
  export COMPOSE_FILE="$WORK/app/docker-compose.prod.yml"
  export ENV_FILE="$WORK/app/.env.prod"
  export HEALTH_TIMEOUT=4 HEALTH_INTERVAL=1
}

current_tag() { sed -n 's/^IMAGE_TAG=//p' "$WORK/app/.env.prod" | tail -1; }
# Octal, not `ls -l`: macOS appends '@' for extended attributes, which made
# a correct 0600 file look wrong.
perms()       { stat -f '%Lp' "$WORK/app/.env.prod" 2>/dev/null \
                  || stat -c '%a' "$WORK/app/.env.prod"; }

run_deploy() {               # run_deploy <tag>; sets OUT and RC
  OUT="$("$DEPLOY" "$@" 2>&1)"; RC=$?
}

# --- T1 happy path ---------------------------------------------------------
hdr "T1  a healthy candidate is deployed"
setup aaaaaaa
FAKE_HEALTHY="bbbbbbb" run_deploy bbbbbbb
[ "$RC" -eq 0 ]                    && ok "exit 0" || bad "expected 0, got $RC"
[ "$(current_tag)" = "bbbbbbb" ]   && ok "IMAGE_TAG moved to the candidate" || bad "tag is $(current_tag)"
[ "$(perms)" = "600" ]             && ok "env file still 0600 (secrets)" || bad "permissions are $(perms)"

# --- T2 rollback on unhealthy candidate ------------------------------------
hdr "T2  an unhealthy candidate is rolled back"
setup aaaaaaa
FAKE_HEALTHY="aaaaaaa" run_deploy bbbbbbb
[ "$RC" -eq 1 ]                    && ok "exit 1 (deployed failed, rolled back)" || bad "expected 1, got $RC"
[ "$(current_tag)" = "aaaaaaa" ]   && ok "IMAGE_TAG restored to the previous image" || bad "tag is $(current_tag)"
grep -q "ROLLED BACK to aaaaaaa"   <<<"$OUT" && ok "reported the rollback" || bad "no rollback message"

# --- T3 rollback itself fails ----------------------------------------------
hdr "T3  rollback failure is reported distinctly, not as a normal failure"
setup aaaaaaa
FAKE_HEALTHY="" run_deploy bbbbbbb
[ "$RC" -eq 2 ]                    && ok "exit 2 (service down)" || bad "expected 2, got $RC"
grep -q "ROLLBACK FAILED"          <<<"$OUT" && ok "said ROLLBACK FAILED" || bad "no distinct message"

# --- T4 pull failure triggers rollback -------------------------------------
hdr "T4  a candidate that cannot even be pulled is rolled back"
setup aaaaaaa
FAKE_HEALTHY="aaaaaaa" FAKE_PULL_FAIL="bbbbbbb" run_deploy bbbbbbb
[ "$RC" -eq 1 ]                    && ok "exit 1" || bad "expected 1, got $RC"
[ "$(current_tag)" = "aaaaaaa" ]   && ok "previous image restored" || bad "tag is $(current_tag)"

# --- T5 same-SHA redeploy ---------------------------------------------------
hdr "T5  redeploying the same SHA is safe and idempotent"
setup aaaaaaa
FAKE_HEALTHY="aaaaaaa" run_deploy aaaaaaa
[ "$RC" -eq 0 ]                    && ok "exit 0" || bad "expected 0, got $RC"
[ "$(current_tag)" = "aaaaaaa" ]   && ok "tag unchanged" || bad "tag is $(current_tag)"
grep -q "same tag already configured" <<<"$OUT" && ok "took the idempotent path" || bad "did not detect the same tag"

hdr "T6  redeploying the same SHA while unhealthy cannot pretend to roll back"
setup aaaaaaa
FAKE_HEALTHY="" run_deploy aaaaaaa
[ "$RC" -eq 2 ]                    && ok "exit 2, no false rollback" || bad "expected 2, got $RC"

# --- T7 moving tags refused -------------------------------------------------
hdr "T7  moving tags are refused before anything changes"
for tag in latest local main master; do
  setup aaaaaaa
  FAKE_HEALTHY="aaaaaaa" run_deploy "$tag"
  if [ "$RC" -ne 0 ] && [ "$(current_tag)" = "aaaaaaa" ]; then
    ok "'$tag' refused, env untouched"
  else
    bad "'$tag' was accepted (rc=$RC, tag=$(current_tag))"
  fi
done

# --- T8 health timeout is bounded and honoured ------------------------------
hdr "T8  health polling is bounded by HEALTH_TIMEOUT"
setup aaaaaaa
start=$SECONDS
HEALTH_TIMEOUT=4 HEALTH_INTERVAL=1 FAKE_HEALTHY="" run_deploy bbbbbbb
elapsed=$(( SECONDS - start ))
# Two waits of ~4s (candidate, then rollback) plus overhead.
[ "$elapsed" -ge 4 ] && [ "$elapsed" -le 20 ] \
  && ok "returned in ${elapsed}s, bounded (not a fixed sleep, not unbounded)" \
  || bad "took ${elapsed}s"
grep -q "NOT healthy within 4s"    <<<"$OUT" && ok "reported the timeout and its budget" || bad "no timeout message"

# --- T9 refuses to deploy without a rollback target -------------------------
hdr "T9  refuses to deploy when there is no rollback target"
setup aaaaaaa
sed -i.bak '/^IMAGE_TAG=/d' "$WORK/app/.env.prod"
FAKE_HEALTHY="bbbbbbb" run_deploy bbbbbbb
[ "$RC" -ne 0 ]                    && ok "refused (exit $RC)" || bad "deployed with no rollback target"
grep -q "refusing to deploy without a rollback target" <<<"$OUT" && ok "said why" || bad "no explanation"

echo
echo "  pass=$pass fail=$fail"
[ "$fail" -eq 0 ]

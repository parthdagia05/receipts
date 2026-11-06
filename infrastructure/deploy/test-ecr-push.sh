#!/usr/bin/env bash
#
# Regression tests for ecr-push.sh. `aws` and `docker` are stubbed, so no
# registry is contacted and no image is built.
#
#   ./test-ecr-push.sh
#
# The behaviour under test is idempotency against IMMUTABLE ECR tags:
# re-running a deploy on the same commit is an ordinary thing to do after a
# transient failure, and it used to fail at the push step before it ever
# reached the deploy.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PUSH="$HERE/ecr-push.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()  { echo "    PASS  $*"; pass=$((pass+1)); }
bad() { echo "    FAIL  $*"; fail=$((fail+1)); }
hdr() { echo; echo "=== $* ==="; }

mkdir -p "$WORK/bin"

cat > "$WORK/bin/aws" <<STUB
#!/usr/bin/env bash
echo "aws \$*" >> "$WORK/calls.log"
# describe-images succeeds only for tags listed in FAKE_EXISTING_TAGS.
tag=""
prev=""
for a in "\$@"; do
  case "\$prev" in --image-ids) tag="\${a#imageTag=}" ;; esac
  prev="\$a"
done
case " \${FAKE_EXISTING_TAGS:-} " in *" \$tag "*) exit 0 ;; esac
exit 254
STUB

cat > "$WORK/bin/docker" <<STUB
#!/usr/bin/env bash
echo "docker \$*" >> "$WORK/calls.log"
exit \${FAKE_BUILD_RC:-0}
STUB

chmod +x "$WORK/bin"/*
export PATH="$WORK/bin:$PATH"

run_push() {                 # run_push <args...>
  : > "$WORK/calls.log"
  OUT="$("$PUSH" "$@" 2>&1)"; RC=$?
}
pushed() { grep -q "docker buildx build" "$WORK/calls.log"; }

REG=123456789012.dkr.ecr.ap-southeast-2.amazonaws.com

# --- P1 ---------------------------------------------------------------------
hdr "P1  a new SHA is built and pushed"
FAKE_EXISTING_TAGS="" run_push "$REG" receipts-api a1b2c3d server
[ "$RC" -eq 0 ] && ok "exit 0" || bad "expected 0, got $RC"
pushed && ok "buildx build --push ran" || bad "nothing was pushed"
grep -q -- "--platform linux/arm64" "$WORK/calls.log" \
  && ok "built for linux/arm64 (Graviton)" || bad "not built for arm64"

# --- P2 the regression ------------------------------------------------------
hdr "P2  re-running the same SHA is a no-op, not a failure"
FAKE_EXISTING_TAGS="a1b2c3d" run_push "$REG" receipts-api a1b2c3d server
[ "$RC" -eq 0 ] && ok "exit 0 (immutable tags do not fail a redeploy)" || bad "expected 0, got $RC"
pushed && bad "it tried to push over an immutable tag" || ok "skipped the push"
grep -q "already published" <<<"$OUT" && ok "said why" || bad "no explanation"

# --- P3 ---------------------------------------------------------------------
hdr "P3  a build failure is a failure"
FAKE_EXISTING_TAGS="" FAKE_BUILD_RC=1 run_push "$REG" receipts-api a1b2c3d server
[ "$RC" -ne 0 ] && ok "exit $RC" || bad "a failed build reported success"

# --- P4 ---------------------------------------------------------------------
hdr "P4  moving tags are refused"
for tag in latest local main master; do
  FAKE_EXISTING_TAGS="" run_push "$REG" receipts-api "$tag" server
  if [ "$RC" -ne 0 ] && ! pushed; then
    ok "'$tag' refused and nothing pushed"
  else
    bad "'$tag' accepted (rc=$RC)"
  fi
done

# --- P5 ---------------------------------------------------------------------
hdr "P5  missing arguments are refused"
run_push "$REG" receipts-api
[ "$RC" -ne 0 ] && ok "missing tag refused" || bad "ran without a tag"
run_push
[ "$RC" -ne 0 ] && ok "no arguments refused" || bad "ran with no arguments"

echo
echo "  pass=$pass fail=$fail"
[ "$fail" -eq 0 ]

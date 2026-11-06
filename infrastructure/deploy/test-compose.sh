#!/usr/bin/env bash
#
# Regression tests for the production Compose file's image reference.
#
#   ./test-compose.sh
#
# Uses `docker compose config`, which resolves variables exactly as `up`
# would, against a throwaway env file. Nothing is started and the real
# .env.prod is not read.
#
# The bug these exist for: `image: receipts-api:${IMAGE_TAG:-local}` has no
# registry, so on the instance it resolved to Docker Hub -- and the file
# also carried a `build:` context that does not exist there. The stack could
# never have started on EC2.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PROD="$REPO/docker-compose.prod.yml"
BUILD="$REPO/docker-compose.build.yml"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()  { echo "    PASS  $*"; pass=$((pass+1)); }
bad() { echo "    FAIL  $*"; fail=$((fail+1)); }
hdr() { echo; echo "=== $* ==="; }

# A complete, non-secret env file. The values are placeholders; none is real.
write_env() {                     # write_env [extra lines...]
  cat > "$WORK/env" <<'EOF'
POSTGRES_PASSWORD=placeholder
RECORD_SERVER_PRIVATE_KEY=placeholder
WORLD_SIGNING_KEY=placeholder
RPC_URL=https://rpc.example
WORLD_APP_ID=app_placeholder
WORLD_RP_ID=rp_placeholder
REVIEW_GATEWAY_ADDRESS=0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD
REVIEW_CONTENT_BASE_URL=https://api.example
CORS_ALLOWED_ORIGINS=https://example
EOF
  for line in "$@"; do printf '%s\n' "$line" >> "$WORK/env"; done
}

config() { docker compose -f "$PROD" --env-file "$WORK/env" config 2>&1; }

REG=123456789012.dkr.ecr.ap-southeast-2.amazonaws.com

hdr "C1  the api image is registry-qualified and pinned"
write_env "ECR_REGISTRY=$REG" "IMAGE_TAG=a1b2c3d"
OUT="$(config)"; RC=$?
[ "$RC" -eq 0 ] && ok "config resolves" || bad "config failed"
grep -qE "image: $REG/receipts-api:a1b2c3d" <<<"$OUT" \
  && ok "image is $REG/receipts-api:a1b2c3d" \
  || bad "image reference is not registry-qualified: $(grep -m1 'receipts-api' <<<"$OUT")"

hdr "C2  the production file carries no build context"
grep -qE "^\s+context:" <<<"$OUT" \
  && bad "a build context survives into the production config" \
  || ok "no build context (the instance has no source tree)"

hdr "C3  a missing registry or tag fails loudly instead of defaulting"
# Captured, not piped: with `set -o pipefail`, `grep -q` exits on the first
# match, docker compose then dies of SIGPIPE, and the pipeline reports 141
# even though the match succeeded.
write_env "IMAGE_TAG=a1b2c3d"
OUT="$(config)"
grep -qi "ECR_REGISTRY is required" <<<"$OUT" \
  && ok "missing ECR_REGISTRY is refused" || bad "missing ECR_REGISTRY was tolerated"

write_env "ECR_REGISTRY=$REG"
OUT="$(config)"
grep -qi "IMAGE_TAG is required" <<<"$OUT" \
  && ok "missing IMAGE_TAG is refused" || bad "missing IMAGE_TAG was tolerated"

write_env "ECR_REGISTRY=$REG" "IMAGE_TAG="
OUT="$(config)"
grep -qi "IMAGE_TAG is required" <<<"$OUT" \
  && ok "empty IMAGE_TAG is refused" || bad "empty IMAGE_TAG was tolerated"

hdr "C4  the local override restores the build context without changing the name"
write_env "ECR_REGISTRY=local" "IMAGE_TAG=dev"
OUT="$(docker compose -f "$PROD" -f "$BUILD" --env-file "$WORK/env" config 2>&1)"
grep -qE "^\s+context:" <<<"$OUT" && ok "override adds a build context" || bad "override does not build"
grep -qE "image: local/receipts-api:dev" <<<"$OUT" \
  && ok "the built image keeps the production name" || bad "override changed the image name"

hdr "C5  caddy does not depend on the api being healthy"
write_env "ECR_REGISTRY=$REG" "IMAGE_TAG=a1b2c3d"
OUT="$(config)"
if printf '%s' "$OUT" | python3 -c "
import sys, re
text = sys.stdin.read()
# the caddy service's depends_on condition for api
m = re.search(r'caddy:.*?depends_on:.*?api:.*?condition:\s*(\S+)', text, re.S)
print(m.group(1) if m else 'NOT-FOUND')
" | grep -q "service_started"; then
  ok "caddy waits only for api to start, so port 80 stays open for ACME"
else
  bad "caddy still gates on api health; an app failure would block certificate issuance"
fi

echo
echo "  pass=$pass fail=$fail"
[ "$fail" -eq 0 ]

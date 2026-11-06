#!/usr/bin/env bash
#
# Regression tests for the instance bootstrap (user-data.sh.tftpl).
#
#   ./test-bootstrap.sh
#
# The real template is rendered with test values and executed, with every
# privileged command replaced by a stub and every absolute path redirected
# into a sandbox. So this exercises the actual script that will run on the
# instance, not a copy of it.
#
# What it is really protecting: the ORDER. Backups and monitoring must be
# enabled before the application is started, and an application that fails
# to start must not take them down with it.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TPL="$REPO/infrastructure/terraform/modules/compute/user-data.sh.tftpl"

pass=0; fail=0
ok()  { echo "    PASS  $*"; pass=$((pass+1)); }
bad() { echo "    FAIL  $*"; fail=$((fail+1)); }
hdr() { echo; echo "=== $* ==="; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- render the real template ----------------------------------------------

render() {                        # render <image_tag> <out>
  IMAGE_TAG_IN="$1" OUT="$2" REPO="$REPO" TPL="$TPL" python3 - <<'PY'
import base64, gzip, os, re
repo = os.environ['REPO']
tpl  = open(os.environ['TPL']).read()

files = {
 'compose_b64':        'docker-compose.prod.yml',
 'caddyfile_b64':      'infrastructure/caddy/Caddyfile',
 'backup_sh_b64':      'infrastructure/backup/backup.sh',
 'alert_sh_b64':       'infrastructure/backup/alert.sh',
 'backup_service_b64': 'infrastructure/backup/receipts-backup.service',
 'backup_timer_b64':   'infrastructure/backup/receipts-backup.timer',
 'backup_alert_b64':   'infrastructure/backup/receipts-backup-alert.service',
}
for k, p in files.items():
    tpl = tpl.replace('${' + k + '}',
                      base64.b64encode(gzip.compress(open(os.path.join(repo, p), 'rb').read())).decode())

scalars = {
 'image_tag': os.environ['IMAGE_TAG_IN'],
 'ecr_registry': '123456789012.dkr.ecr.ap-southeast-2.amazonaws.com',
 'aws_region': 'ap-southeast-2',
 'secret_id': 'receipts/prod/runtime',
 'site_address': 'api.receipts.example.test',
 'acme_email': 'ops@example.test',
 'compose_version': 'v2.29.7',
 'backup_bucket': 'receipts-prod-backups-123456789012',
 'backup_prefix': 'postgres',
 'backup_retention_days': '7',
 'postgres_db': 'receipts', 'postgres_user': 'receipts',
 'chain_id': '11155111',
 'review_gateway_address': '0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD',
 'receipt_settler_address': '0xC3AA7a2F43d83680f9E0B97e0Eb4fD01E421ceDe',
 'identity_registry_address': '0x8004A818BFB912233c491871b3d84c89A494BD9e',
 'reputation_registry_address': '0x8004B663056A597Dffe9eCcC1965A193B7388713',
 'gateway_deploy_block': '12064002',
 'world_app_id': 'app_7de77482d1055cc43c0c5a2a7ede66a5',
 'world_rp_id': 'rp_d3afb91156ea1942',
 'world_environment': 'production',
 'review_content_base_url': 'https://api.receipts.example.test',
 'cors_allowed_origins': 'https://receipts.example.test',
}
for k, v in scalars.items():
    tpl = tpl.replace('${' + k + '}', v)

# Terraform's `$${...}` escape becomes a literal `${...}` after rendering.
tpl = tpl.replace('$${', '${')

left = set(re.findall(r'\$\{([a-z_0-9]+)\}', tpl)) - {'aws:InstanceId'}
assert not left, f"unrendered template vars: {left}"
open(os.environ['OUT'], 'w').write(tpl)
PY
}

# --- sandbox ----------------------------------------------------------------

sandbox() {                       # sandbox <rendered> <sandboxed-out>
  local src="$1" dst="$2"
  # Redirect every privileged absolute path into $SB. The script is executed
  # verbatim apart from these prefixes.
  sed \
    -e "s#/opt/receipts#$SB/opt/receipts#g" \
    -e "s#/etc/systemd/system#$SB/etc/systemd/system#g" \
    -e "s#/var/log/receipts-bootstrap.log#$SB/var/log/receipts-bootstrap.log#g" \
    -e "s#/var/lib/receipts-bootstrap-status#$SB/var/lib/receipts-bootstrap-status#g" \
    -e "s#/opt/aws/amazon-cloudwatch-agent#$SB/opt/aws/amazon-cloudwatch-agent#g" \
    -e "s#/usr/local/lib/docker/cli-plugins#$SB/usr/local/lib/docker/cli-plugins#g" \
    "$src" > "$dst"
}

make_stubs() {
  # Directories that always exist on a real instance. Without them the
  # script fails for a reason the instance would never hit.
  mkdir -p "$SB/bin" "$SB/var/log" "$SB/var/lib" "$SB/etc/systemd/system"

  cat > "$SB/bin/dnf" <<STUB
#!/usr/bin/env bash
echo "dnf \$*" >> "$SB/calls.log"
# Installing the agent must create the tree the script then writes into.
case " \$* " in *" amazon-cloudwatch-agent "*)
  mkdir -p "$SB/opt/aws/amazon-cloudwatch-agent/etc" "$SB/opt/aws/amazon-cloudwatch-agent/bin"
  cat > "$SB/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl" <<'INNER'
#!/usr/bin/env bash
echo "cwagent-ctl \$*" >> "SBPATH/calls.log"
exit 0
INNER
  sed -i.bak "s#SBPATH#$SB#" "$SB/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl"
  chmod +x "$SB/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl"
;; esac
exit 0
STUB

  cat > "$SB/bin/systemctl" <<STUB
#!/usr/bin/env bash
echo "systemctl \$*" >> "$SB/calls.log"
exit 0
STUB

  cat > "$SB/bin/docker" <<STUB
#!/usr/bin/env bash
echo "docker \$*" >> "$SB/calls.log"
case " \$* " in
  *" up "*) exit \${FAKE_APP_START_RC:-0} ;;
esac
exit 0
STUB

  cat > "$SB/bin/curl" <<STUB
#!/usr/bin/env bash
echo "curl \$*" >> "$SB/calls.log"
# The compose-plugin download: -o <path>
prev=""; out=""
for a in "\$@"; do [ "\$prev" = "-o" ] && out="\$a"; prev="\$a"; done
[ -n "\$out" ] && { mkdir -p "\$(dirname "\$out")"; echo "#!/bin/sh" > "\$out"; }
exit 0
STUB

  cat > "$SB/bin/aws" <<STUB
#!/usr/bin/env bash
echo "aws \$1 \$2" >> "$SB/calls.log"
case "\$1 \$2" in
  "secretsmanager get-secret-value")
     [ -n "\${FAKE_SECRET_JSON:-}" ] || exit 1
     printf '%s' "\$FAKE_SECRET_JSON"; exit 0 ;;
  "ecr get-login-password") echo "fake-token"; exit 0 ;;
esac
exit 0
STUB

  chmod +x "$SB/bin/"*
}

FULL_SECRET='{"RECORD_SERVER_PRIVATE_KEY":"0xAAA","WORLD_SIGNING_KEY":"0xBBB","RPC_URL":"https://rpc.example","POSTGRES_PASSWORD":"pw-not-real"}'

run_bootstrap() {                 # run_bootstrap <image_tag>; sets OUT/RC
  SB="$WORK/sb.$RANDOM"; mkdir -p "$SB"
  make_stubs
  # A silent render failure would leave an empty script that "passes" by
  # doing nothing, which is the worst possible outcome for a test harness.
  if ! render "$1" "$SB/user-data.sh"; then
    echo "    HARNESS ERROR: template render failed" >&2
    OUT="render failed"; RC=99; return
  fi
  [ -s "$SB/user-data.sh" ] || { echo "    HARNESS ERROR: rendered script is empty" >&2; OUT=""; RC=99; return; }
  sandbox "$SB/user-data.sh" "$SB/run.sh"
  [ -s "$SB/run.sh" ] || { echo "    HARNESS ERROR: sandboxed script is empty" >&2; OUT=""; RC=99; return; }
  OUT="$(PATH="$SB/bin:$PATH" bash "$SB/run.sh" 2>&1)"; RC=$?
  if [ "${BOOTSTRAP_DEBUG:-0}" = 1 ]; then
    echo "--- rc=$RC output ---"; echo "$OUT"; echo "--- calls ---"; cat "$SB/calls.log" 2>/dev/null; echo "---"
  fi
}

status()  { cat "$SB/var/lib/receipts-bootstrap-status" 2>/dev/null || echo "<none>"; }
calls()   { cat "$SB/calls.log" 2>/dev/null; }
# Line number of the first matching call, for ordering assertions.
call_at() { grep -n -- "$1" "$SB/calls.log" 2>/dev/null | head -1 | cut -d: -f1; }

# --- B1 happy path ----------------------------------------------------------
hdr "B1  a clean boot starts everything"
FAKE_SECRET_JSON="$FULL_SECRET" run_bootstrap a1b2c3d
[ "$RC" -eq 0 ]                            && ok "exit 0" || bad "exit $RC"
[ "$(status)" = "app=started" ]            && ok "status app=started" || bad "status $(status)"
calls | grep -q "systemctl enable --now receipts-backup.timer" && ok "backup timer enabled" || bad "timer not enabled"
calls | grep -q "cwagent-ctl"              && ok "cloudwatch agent configured" || bad "agent not configured"
[ -f "$SB/opt/receipts/.env.prod" ]        && ok ".env.prod written" || bad "no .env.prod"

# --- B2 ORDERING ------------------------------------------------------------
hdr "B2  backups and monitoring are configured BEFORE the application"
t=$(call_at "systemctl enable --now receipts-backup.timer")
a=$(call_at "cwagent-ctl")
u=$(call_at "docker compose -f .* up -d")
if [ -n "$t" ] && [ -n "$u" ] && [ "$t" -lt "$u" ]; then
  ok "timer enabled (call $t) before app start (call $u)"
else
  bad "ordering wrong: timer=$t app=$u"
fi
if [ -n "$a" ] && [ -n "$u" ] && [ "$a" -lt "$u" ]; then
  ok "monitoring configured (call $a) before app start (call $u)"
else
  bad "ordering wrong: agent=$a app=$u"
fi

# --- B3 the regression that started this ------------------------------------
hdr "B3  an application failure does NOT disable backups or monitoring"
FAKE_SECRET_JSON="$FULL_SECRET" FAKE_APP_START_RC=1 run_bootstrap a1b2c3d
[ "$RC" -eq 0 ]                            && ok "bootstrap still exits 0" || bad "exit $RC"
[ "$(status)" = "app=failed" ]             && ok "status records app=failed" || bad "status $(status)"
calls | grep -q "systemctl enable --now receipts-backup.timer" \
  && ok "backup timer STILL enabled after app failure" || bad "timer lost"
calls | grep -q "cwagent-ctl" && ok "monitoring STILL configured" || bad "monitoring lost"
grep -q "ERROR: the application did not start" <<<"$OUT" \
  && ok "failure reported loudly" || bad "failure not reported"
grep -q "Backups and monitoring ARE running" <<<"$OUT" \
  && ok "message says what survived" || bad "no reassurance in the message"

# --- B4 missing secret keys -------------------------------------------------
hdr "B4  a half-populated secret fails fast and names the key"
for missing in RECORD_SERVER_PRIVATE_KEY WORLD_SIGNING_KEY RPC_URL POSTGRES_PASSWORD; do
  partial="$(printf '%s' "$FULL_SECRET" | M="$missing" python3 -c "
import json,sys,os
d=json.load(sys.stdin); d.pop(os.environ['M']); print(json.dumps(d))")"
  FAKE_SECRET_JSON="$partial" run_bootstrap a1b2c3d
  if [ "$RC" -ne 0 ] && grep -q "missing a non-empty string for key: $missing" <<<"$OUT"; then
    ok "missing $missing -> aborted and named it"
  else
    bad "missing $missing -> rc=$RC, message did not name the key"
  fi
done

hdr "B5  an empty string is treated as missing, and no value is ever printed"
FAKE_SECRET_JSON='{"RECORD_SERVER_PRIVATE_KEY":"0xAAA","WORLD_SIGNING_KEY":"","RPC_URL":"https://rpc.example","POSTGRES_PASSWORD":"pw-not-real"}' \
  run_bootstrap a1b2c3d
[ "$RC" -ne 0 ] && ok "empty value rejected" || bad "empty value accepted"
grep -q "0xAAA" <<<"$OUT" && bad "a secret value was printed" || ok "no secret value in the output"

# --- B6 moving tags ---------------------------------------------------------
hdr "B6  a moving image tag is refused before anything is installed"
for tag in latest local main master; do
  FAKE_SECRET_JSON="$FULL_SECRET" run_bootstrap "$tag"
  if [ "$RC" -ne 0 ] && grep -q "moving tag" <<<"$OUT"; then
    ok "'$tag' refused"
  else
    bad "'$tag' accepted (rc=$RC)"
  fi
done

echo
echo "  pass=$pass fail=$fail"
[ "$fail" -eq 0 ]

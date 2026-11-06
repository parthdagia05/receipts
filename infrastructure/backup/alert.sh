#!/usr/bin/env bash
#
# Failure notification for the backup timer.
#
#   ./alert.sh "receipts-backup.service failed"
#
# Two modes, chosen by whether SNS_TOPIC_ARN is set:
#
#   unset  -- writes a distinctive line to the journal and exits 0. This is
#             the state before monitoring exists. It is honest about being
#             only a journal line, because a notification nobody receives is
#             worse than none: it invites the belief that someone was told.
#
#   set    -- publishes to SNS as well. Nothing else needs to change when
#             monitoring arrives; set the ARN in /opt/receipts/backup.env.
#
# Nothing here reads a database credential or a connection string, so the
# message is safe to send to a topic with human subscribers.

set -Eeuo pipefail

SNS_TOPIC_ARN="${SNS_TOPIC_ARN:-}"
HOSTNAME_SHORT="$(hostname -s 2>/dev/null || echo unknown-host)"

message="${1:-receipts backup failed}"
stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# The journal line is emitted in both modes, so the instance always has a
# local record even if SNS is unreachable.
printf '%s [backup-alert] ALERT %s on %s\n' "$stamp" "$message" "$HOSTNAME_SHORT" >&2

# The last 20 lines of the failed run, to save a round trip to the box.
if command -v journalctl >/dev/null 2>&1; then
  journalctl -u receipts-backup.service -n 20 --no-pager 2>/dev/null \
    | sed 's/^/  | /' >&2 || true
fi

if [[ -z "$SNS_TOPIC_ARN" ]]; then
  printf '%s [backup-alert] SNS_TOPIC_ARN is unset: journal only, nobody was notified\n' \
    "$stamp" >&2
  exit 0
fi

if ! command -v aws >/dev/null 2>&1; then
  printf '%s [backup-alert] SNS_TOPIC_ARN is set but the aws CLI is missing\n' "$stamp" >&2
  exit 1
fi

aws sns publish \
  --topic-arn "$SNS_TOPIC_ARN" \
  --subject "Receipts backup failed on ${HOSTNAME_SHORT}" \
  --message "${stamp} ${message} on ${HOSTNAME_SHORT}. Check: journalctl -u receipts-backup.service -n 50" \
  >/dev/null

printf '%s [backup-alert] published to SNS\n' "$stamp" >&2

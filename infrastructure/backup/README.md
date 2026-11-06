# Backup and recovery

Two independent mechanisms, because they fail differently and neither is
sufficient alone.

| | covers | loses | known-good? |
|---|---|---|---|
| `pg_dump` nightly → S3 | bad migration, dropped table, logical corruption | everything since the last run | **yes** — every archive is verified with `pg_restore --list` before it is kept |
| EBS snapshot (DLM) | instance or volume destroyed | up to 24h | no — crash-consistent copy of a live filesystem; PostgreSQL replays WAL on first start, which usually works |

The dump is the one you will actually use. The snapshot is for the morning
the instance is simply gone.

## Files

| File | Goes to | Purpose |
|---|---|---|
| `backup.sh` | `/opt/receipts/backup.sh` | dump → verify → promote → upload → prune |
| `restore.sh` | `/opt/receipts/restore.sh` | restore into a **new** database and report what landed |
| `alert.sh` | `/opt/receipts/alert.sh` | failure notification; journal-only until `SNS_TOPIC_ARN` is set |
| `backup.env.example` | `/opt/receipts/backup.env` | configuration; contains no secrets |
| `receipts-backup.service` | `/etc/systemd/system/` | the job |
| `receipts-backup.timer` | `/etc/systemd/system/` | 03:00 UTC nightly |
| `receipts-backup-alert.service` | `/etc/systemd/system/` | `OnFailure=` target |

Terraform lives in `../terraform/modules/backup` (S3 bucket, KMS key,
write-only IAM policy) and `../terraform/modules/snapshots` (DLM policy).

## Install

```bash
sudo install -m 750 backup.sh restore.sh alert.sh /opt/receipts/
sudo install -m 600 backup.env.example /opt/receipts/backup.env
sudo $EDITOR /opt/receipts/backup.env          # set S3_BUCKET
sudo install -m 644 receipts-backup.service receipts-backup.timer \
                    receipts-backup-alert.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now receipts-backup.timer

systemctl list-timers receipts-backup.timer    # confirm the next run
sudo systemctl start receipts-backup.service   # run one now
journalctl -u receipts-backup.service -n 50
```

## Why the ordering matters

A dump is written to a temporary file **in the backup directory**, verified,
and only then renamed into place. So:

- a file named `receipts-<stamp>.dump` has passed `pg_restore --list`;
- the rename is within one filesystem, so it is atomic — there is no window
  where a half-written file carries a real backup's name;
- retention only ever considers files with that name, so a partial file from
  a crashed run is never counted as a survivor and never deleted as if it
  were an old backup;
- **nothing is pruned unless a new backup has just been verified.** A week of
  failures leaves a week-old backup in place rather than an empty directory.

Retention keeps the newest `RETENTION_MIN_KEEP` (default 3) regardless of
age, with a hard floor of 1 even if that is misconfigured to 0.

There is no database password anywhere in this. `pg_dump` runs inside the
postgres container over its local socket, so no credential is passed on a
command line, in an environment variable, or in a log line.

## Restore

### Routine drill — do this quarterly

An untested backup is a hypothesis. This never touches the live database:

```bash
cd /opt/receipts
./restore.sh backups/receipts-<STAMP>.dump
```

It validates the archive, creates `receipts_restore_<stamp>`, restores into
it, and prints the table list with row counts. Compare against production,
then drop it:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -T postgres psql -U receipts -d postgres \
  -c 'DROP DATABASE "receipts_restore_<stamp>";'
```

`restore.sh` refuses to target the live database unless you pass
`--force-into-production`, and refuses to restore into a database that
already exists rather than merging two points in time.

### From S3

The instance has no permission to read the bucket — that is deliberate, so a
compromised instance cannot read or destroy the backups. Use operator
credentials:

```bash
aws s3 ls s3://<BUCKET>/postgres/
aws s3 cp s3://<BUCKET>/postgres/receipts-<STAMP>.dump /tmp/
./restore.sh /tmp/receipts-<STAMP>.dump
```

### The volume is lost, the instance is fine

```bash
cd /opt/receipts
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d postgres
# the schema is created by the API at startup; pg_restore supplies the data
./restore.sh backups/receipts-<STAMP>.dump receipts --force-into-production
docker compose -f docker-compose.prod.yml --env-file .env.prod restart api
curl -fsS http://127.0.0.1:8080/health
```

If the new volume is empty, restore into `receipts` directly as above. If it
has partial data, restore into a new database, verify, then rename — never
`pg_restore` over a populated database.

### The instance is lost

1. Restore the most recent DLM snapshot into a new volume, attach it to a
   replacement instance, start the stack. You are back with at most 24h lost.
2. Then check whether a newer dump exists in S3. If it does, restore it into
   a scratch database, compare, and promote — the snapshot may be older and
   is crash-consistent rather than verified.

### A backup failed

A failed run promotes nothing, so the previous good backup is still there:

```bash
journalctl -u receipts-backup.service -n 50
ls -l /opt/receipts/backups/            # the last good one is still present
sudo systemctl start receipts-backup.service   # retry
```

If the failure was the upload, the verified local copy exists and can be
pushed by hand with operator credentials.

## Not covered

- **Region loss and account compromise.** No cross-region or cross-account
  copy is configured. Both the bucket and the snapshots live in one account
  in one region.
- **Point-in-time recovery.** There is no WAL archiving, so the exposure is
  up to 24 hours. If that becomes unacceptable, the answer is continuous WAL
  shipping, not a more frequent `pg_dump`.
- **Alerting.** Until `SNS_TOPIC_ARN` is set in `backup.env`, a failure
  writes to the journal and nobody is told.

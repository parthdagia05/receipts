# Runbook

Operational procedures for the single-EC2 deployment. Written to be followed
under pressure by someone who did not build it.

---

## 1. Terraform state

One environment, `envs/prod`, one state file. Backend is S3 with a DynamoDB
lock table, both created **by hand before the first `init`** — a backend
cannot bootstrap itself.

State records every resource attribute in clear text, including values a
configuration marks sensitive. The bucket is therefore treated as a secret
store, not as a scratch bucket.

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="receipts-tfstate-$ACCOUNT"
REGION=ap-south-1

aws s3api create-bucket --bucket "$BUCKET" \
  --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION"

# 1. Versioning. This is the recovery mechanism for a corrupted or
#    truncated state file, which is otherwise unrecoverable.
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

# 2. Public access blocked, all four.
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# 3. Encryption at rest. `encrypt = true` in the backend block encrypts the
#    state OBJECT; this makes the BUCKET refuse anything unencrypted, so a
#    future write by another tool cannot land in the clear.
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": { "SSEAlgorithm": "AES256" },
      "BucketKeyEnabled": true
    }]
  }'

# 4. ACLs off. Object-ownership confusion is the usual cause of a bucket
#    that is private while its objects are not.
aws s3api put-bucket-ownership-controls --bucket "$BUCKET" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'

# 5. TLS-only, and no unencrypted writes. S3 is reachable over plain HTTP
#    and nothing here needs that.
cat > /tmp/tfstate-policy.json <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::$BUCKET", "arn:aws:s3:::$BUCKET/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    },
    {
      "Sid": "DenyUnencryptedWrites",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::$BUCKET/*",
      "Condition": {
        "StringNotEquals": { "s3:x-amz-server-side-encryption": "AES256" }
      }
    }
  ]
}
POLICY
aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///tmp/tfstate-policy.json
rm -f /tmp/tfstate-policy.json

# 6. Expire superseded versions. Without this, every apply's state is kept
#    forever. 90 days is long enough to recover from a bad apply nobody
#    noticed for a quarter.
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-noncurrent-state",
      "Status": "Enabled",
      "Filter": {},
      "NoncurrentVersionExpiration": { "NoncurrentDays": 90 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }]
  }'

aws dynamodb create-table --table-name receipts-tflock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST --region "$REGION"
```

### Restricting access

The steps above make the bucket private and encrypted; they do not decide
*who* may read it. Access is whoever your IAM already allows, so restrict it
explicitly — administrators and whatever principal runs Terraform, nothing
else:

```bash
# Attach to the administrator / Terraform-runner role, scoped to this bucket.
cat > /tmp/tfstate-access.json <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::$BUCKET" },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::$BUCKET/prod/*" },
    { "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
      "Resource": "arn:aws:dynamodb:$REGION:$ACCOUNT:table/receipts-tflock" }
  ]
}
POLICY
```

Note the deployment role defined in `modules/cicd` is deliberately **not**
granted any of this. CI deploys images; it does not change infrastructure,
and it cannot read a state file that describes the whole account.

> `terraform destroy` **destroys the EBS volume and the database with it.**
> It is not a cost-control measure. To save money, stop the instance
> (cost-estimate.md).

---

## 2. First deployment

```bash
# 1. Certificates. CloudFront accepts us-east-1 ONLY, whatever region
#    everything else is in. This catches people out.
#      receipts.<DOMAIN>  ->  ACM in us-east-1
#    The API needs no ACM certificate: Caddy issues its own via ACME.
#    Validate by DNS; add the CNAME in Cloudflare, DNS-only (grey cloud).

# 2. Infrastructure
cd infrastructure/terraform/envs/prod
terraform init
terraform plan -out=tfplan      # READ THIS before applying
terraform apply tfplan

# 3. DNS in Cloudflare
#      A      api.receipts   -> <instance EIP>        grey cloud
#      CNAME  receipts       -> <cloudfront domain>   grey cloud
#
#    BOTH grey-clouded. Orange-cloud on api breaks Caddy's ACME HTTP-01
#    challenge; orange-cloud on receipts puts a second CDN in front of
#    CloudFront.

# 4. Secrets onto the instance. Never in Terraform -- a value in a .tf file
#    is a value in state and in git history.
aws ssm start-session --target <INSTANCE_ID> --region ap-south-1

sudo install -d -m 700 /opt/receipts
sudo touch /opt/receipts/.env.prod
sudo chmod 600 /opt/receipts/.env.prod
sudo chown root:root /opt/receipts/.env.prod
sudo nano /opt/receipts/.env.prod      # populate; see the schema below

# 5. Bring it up
cd /opt/receipts
sudo docker compose -f docker-compose.prod.yml --env-file .env.prod up -d

# 6. Verify -- do not assume
sudo docker compose -f docker-compose.prod.yml ps        # both healthy
curl -s localhost:8080/health                            # {"status":"ok"}
curl -s https://api.receipts.<DOMAIN>/health             # through Caddy
```

### `.env.prod` schema

```ini
# Secrets
POSTGRES_PASSWORD=
RECORD_SERVER_PRIVATE_KEY=
WORLD_SIGNING_KEY=
RPC_URL=

# World ID
WORLD_APP_ID=
WORLD_RP_ID=
WORLD_ENVIRONMENT=production      # MUST match the Developer Portal

# Chain
CHAIN_ID=11155111
REVIEW_GATEWAY_ADDRESS=
RECEIPT_SETTLER_ADDRESS=
IDENTITY_REGISTRY_ADDRESS=
REPUTATION_REGISTRY_ADDRESS=
GATEWAY_DEPLOY_BLOCK=

# Production hardening -- both default to OFF in code, so they must be set
CORS_ALLOWED_ORIGINS=https://receipts.<DOMAIN>
TRUST_PROXY=true

REVIEW_CONTENT_BASE_URL=https://api.receipts.<DOMAIN>
IMAGE_TAG=<commit-sha>
```

---

## 3. Routine deployment

### Backend

```bash
aws ssm start-session --target <INSTANCE_ID>
cd /opt/receipts

aws ecr get-login-password --region ap-south-1 \
  | sudo docker login --username AWS --password-stdin <ACCOUNT>.dkr.ecr.ap-south-1.amazonaws.com

sudo sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=<new-sha>/" .env.prod
sudo docker compose -f docker-compose.prod.yml --env-file .env.prod pull api
sudo docker compose -f docker-compose.prod.yml --env-file .env.prod up -d api

sudo docker compose -f docker-compose.prod.yml ps
curl -s localhost:8080/health
```

Images are tagged with the **commit SHA, never `latest`**. `latest` makes
rollback ambiguous and "what is running?" unanswerable.

**This is a brief outage.** One instance, one container: the API is down for
the few seconds between stop and healthy. Accepted trade-off of the
single-instance design.

### Frontend

```bash
cd web
VITE_API_BASE_URL=https://api.receipts.<DOMAIN> \
VITE_RPC_URL=<public, key-free endpoint> \
VITE_CHAIN_ID=11155111 \
  npm ci && npm run build

# Assets FIRST, index.html LAST. Reverse it and the new HTML briefly
# references assets that are not uploaded yet.
aws s3 sync dist/ s3://<BUCKET>/ --delete \
  --cache-control "public,max-age=31536000,immutable" --exclude index.html
aws s3 cp dist/index.html s3://<BUCKET>/index.html --cache-control "no-cache"

# index.html only. Asset filenames are content-hashed and never stale.
aws cloudfront create-invalidation --distribution-id <ID> --paths "/index.html"
```

`VITE_*` values are baked in at build time. A bundle belongs to the
environment it was built for; there is no promoting a staging build.

---

## 4. Backup

### Nightly logical dump

Implemented in `infrastructure/backup/`. **Install and operate it from
there** — `infrastructure/backup/README.md` has the install commands, the
restore procedures and the drill.

The hand-rolled script that used to live here has been removed rather than
left as an alternative, because it had three faults worth naming:

- it wrote the dump straight to its final filename, so an interrupted run
  left a truncated file that looked like a backup;
- nothing verified the archive, so corruption was discovered at restore time;
- `find … -mtime +7 -delete` had no floor, so a week of failures deleted the
  last good backup and left nothing.

The replacement verifies every archive with `pg_restore --list` before
promoting it, promotes by atomic rename, prunes only after a new backup has
succeeded, and never deletes the newest few whatever their age.

### Why both this and EBS snapshots

They cover different failures, and neither is sufficient alone:

| Mechanism | Covers | Does not cover |
| --- | --- | --- |
| EBS snapshot (DLM, daily, 7-day) | instance or volume loss | a bad migration — the snapshot may be mid-write |
| `pg_dump` (nightly → S3) | logical corruption, bad migration, single-table restore | the minutes since the last dump |

**An untested backup is a hypothesis.** Restore one to a scratch container
quarterly.

---

## 5. Restore

### From a logical dump

Use `infrastructure/backup/restore.sh`; the full procedure, including the
S3 download and the quarterly drill, is in
`infrastructure/backup/README.md`.

```bash
cd /opt/receipts
aws s3 cp s3://<BUCKET>/postgres/receipts-<STAMP>.dump /tmp/restore.dump

# Verify into a scratch database FIRST. This touches nothing live.
./restore.sh /tmp/restore.dump

# Only once the row counts look right:
sudo docker compose -f docker-compose.prod.yml --env-file .env.prod stop api
./restore.sh /tmp/restore.dump receipts --force-into-production
sudo docker compose -f docker-compose.prod.yml --env-file .env.prod start api
curl -fsS localhost:8080/health
```

Stopping the API first is not optional: `pg_restore` running under a live
writer gives a torn database.

The previous version of this section piped a dump straight into
`pg_restore --clean --if-exists` against the live database with no prior
validation — a corrupt archive would have dropped every table and then
failed to refill them.

### From an EBS snapshot

Create a volume from the snapshot, attach it to a new instance, and repoint
DNS. This is instance replacement, not an in-place restore; budget 30+ minutes.

---

## 6. Rollback

### Backend — ~1 minute

```bash
sudo sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=<previous-sha>/" /opt/receipts/.env.prod
sudo docker compose -f docker-compose.prod.yml --env-file .env.prod up -d api
```

Works because images are SHA-tagged and the previous one is still in ECR.

**Rollback does not revert a migration.** If release N added a column, N−1
must still run with it present. Keep migrations additive and
backward-compatible for one release.

### Frontend — ~1 minute

S3 versioning is enabled, so a previous object version can be restored. If CI
archived the build under its SHA, sync that prefix back and invalidate
`/index.html`.

---

## 7. Incidents

### API returns 503

`/health` returns 503 only when the database is unreachable.

```bash
sudo docker compose -f docker-compose.prod.yml ps
sudo docker compose -f docker-compose.prod.yml logs --tail=100 postgres
```

### Container restarting in a loop

**Most likely `verifyDeployment` failing.** It calls `process.exit(1)` when
the RPC is unreachable or `recordServerSigner` does not match the configured
key. Deliberate — a server that cannot produce acceptable attestations must
not serve traffic.

```bash
sudo docker compose -f docker-compose.prod.yml logs --tail=50 api
```

| Message | Cause |
| --- | --- |
| `could not reach the configured RPC endpoint` | RPC outage. Wait, or change `RPC_URL`. |
| `RPC endpoint serves chain X, but CHAIN_ID is Y` | Wrong endpoint configured. |
| `ReviewGateway expects attestations from 0x… but RECORD_SERVER_PRIVATE_KEY derives 0x…` | **Wrong secret.** The gateway's signer is immutable — fix the secret. Do not redeploy contracts. |

Messages name addresses and chain ids and **never key material**, so they are
safe to paste into an incident channel.

### Reviews fail at World ID verification

Check `WORLD_ENVIRONMENT` against the Developer Portal. A mismatch rejects
every proof locally with `environment_mismatch` **before** the Portal is
contacted, so it looks like a bad proof rather than a config fault. **This is
the single likeliest cause of a broken demo.**

### Clients getting 429

Expected above 120 req/min globally or 10/min on `/api/reviews/verify`. If
legitimate traffic is being limited, raise `DEFAULT_RATE_LIMITS` and redeploy.
If `TRUST_PROXY=true` is missing behind Caddy, every client shares one
counter — check that first.

### Frontend loads but shows "RPC unreachable"

`VITE_RPC_URL` must send permissive CORS headers. `rpc.sepolia.org` sends
none and fails in a browser while working from `curl`. Ad blockers also block
many public RPC hostnames, which is indistinguishable from the host being down.

### Disk full

**The likeliest real outage.** PostgreSQL data, Docker images and logs share
one 30 GB volume.

```bash
df -h /
sudo docker system prune -af --filter "until=168h"
```

---

## 8. Routine checks

| Interval | Check |
| --- | --- |
| Daily | `/health` responds; both containers healthy |
| Weekly | `df -h` disk headroom; last night's dump landed in S3 |
| Monthly | ECR lifecycle expiring old images; cost vs cost-estimate.md |
| Quarterly | **Restore a dump to a scratch container.** An untested backup is a hypothesis. |
| Quarterly | `sudo dnf update` and reboot during a quiet window |

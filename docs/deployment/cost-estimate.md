# Monthly Cost — ap-south-1

On-demand `ap-south-1` list prices, rounded. An engineering estimate, not a
quote — re-check against AWS pricing before committing.

## Assumptions

- Student credits; cost is the dominant constraint
- Demo / early traffic: < 100k requests/month, < 50 GB egress
- One `t4g.small` (2 vCPU, 2 GiB, ARM), 30 GB gp3, running continuously
- PostgreSQL in Docker on that instance — **not RDS**
- Frontend bundle ~1 MB, a few thousand visitors

---

## Estimate

| Component | Spec | Monthly (USD) |
| --- | --- | --- |
| **EC2** `t4g.small` | on-demand, 730 h | **$12.26** |
| **EBS** gp3 root | 30 GB @ $0.0912/GB | **$2.74** |
| **Elastic IP** | attached to a running instance | **$0.00** |
| EBS snapshots | ~20 GB incremental @ $0.05 | $1.00 |
| CloudFront | ~10 GB egress + requests | $1.00 |
| S3 | < 1 GB, versioned | $0.10 |
| CloudWatch | ~2 GB logs, few alarms | $0.60 |
| Secrets Manager | 4 × $0.40 | $1.60 |
| ECR | < 1 GB with lifecycle policy | $0.10 |
| ACM, Cloudflare DNS | — | $0.00 |
| **Total** | | **≈ $19/month** |

With a **1-year no-upfront Savings Plan** on the instance (≈ 28% off):
**≈ $16/month**.

An Elastic IP is free **only while attached to a running instance**. Stop the
instance and it bills at ~$3.60/month. Relevant to §"Stopping between demos".

---

## Why this is $19 and not $85

A previous iteration targeted ECS Fargate + ALB + RDS:

| Component | Fargate design | This design | Saved |
| --- | --- | --- | --- |
| NAT Gateway | $34 | **$0** (public subnet + EIP) | $34 |
| ALB | $18 | **$0** (Caddy on the instance) | $18 |
| RDS t4g.micro | $15 | **$0** (Postgres in Docker) | $15 |
| Compute | $13 (2 tasks) | $12 (1 instance) | $1 |
| **Total** | **$85** | **$19** | **$66** |

Three decisions account for $67 of that, and each buys the saving with
something real.

### NAT Gateway → public subnet (saves $34)

**What is lost:** the instance has a public IP and is directly addressable.

**Why it is acceptable here:** the security group opens 80, 443 and SSH from
one address. The API binds `127.0.0.1` and PostgreSQL publishes no host port
at all, so even a wide-open security group would not expose the database.
Three independent layers, all of which would have to fail.

**When to revisit:** real user data, or any compliance requirement.

### ALB → Caddy on the instance (saves $18)

**What is lost:** health-check-based removal of a bad target, access logs,
and a place to attach a WAF.

**Why it is acceptable here:** an ALB load-balances across *one* target. Its
health check would remove the only instance from rotation, which is an outage
either way. Caddy handles TLS and ACME in four lines of config.

**When to revisit:** a second instance.

### RDS → PostgreSQL in Docker (saves $15)

This is the **largest real risk** of the three, and the least visible.

**What is lost:**

- Automated point-in-time recovery
- Automated minor-version patching
- Automated failover (though single-AZ RDS has none either)
- A database that survives instance termination

**Why it is acceptable here:** most tables hold short-lived state — World ID
requests and authorizations expire in 300 seconds. `review_contents` is the
only durable table and it is content-addressed, so it can be rebuilt from
chain events: every `feedbackHash` is in a `ReviewSubmitted` log.

**Mitigation is mandatory, not optional.** Nightly `pg_dump` to S3 *and*
daily EBS snapshots, because they cover different failures (see
[architecture.md](./architecture.md) §5). Without both, this saving is
borrowed against an outage.

**When to revisit:** before real users. $15/month is cheap for managed
backups and PITR.

---

## Scenarios

| Scenario | Monthly | Notes |
| --- | --- | --- |
| **This design** | **$19** | one t4g.small, Postgres in Docker |
| With Savings Plan | $16 | 1-year commitment |
| `t4g.micro` instead | $13 | 1 GiB RAM: Node + Postgres + Caddy is tight |
| **+ RDS t4g.micro** | $34 | the upgrade worth making first |
| + second instance + ALB | $49 | redundancy; needs Redis for rate limiting |
| Fargate design | $85 | for comparison |

### Stopping between demos

EC2 and EBS are ~$15 of the $19 and bill whether or not anyone uses the
service. Stopping the instance between a demo and judging:

- EC2 compute → $0
- EBS → still billed (~$2.74); the volume persists, which is the point
- **Elastic IP → starts billing** at ~$3.60/month while detached from a
  running instance

So stopping saves roughly **$8/month**, not $15. The Docker volume and all
data survive a stop/start, and the EIP keeps the Cloudflare record valid.

`terraform destroy` would save everything but **destroys the database volume**.
Do not use it as a cost-control measure.

---

## What would change these numbers

- **Reputation endpoint log scans.** Rescans from the gateway deploy block on
  every request (~4,000 blocks today, 0.5 s). As the chain grows this becomes
  the dominant RPC cost and may force a paid provider tier or a cache.
- **Disk.** PostgreSQL data, Docker images and logs share one 30 GB volume.
  At 80% full this becomes an outage, not a cost — see the alarm in
  architecture.md §6.
- **Egress.** 100 GB/month of CloudFront would add ~$10.

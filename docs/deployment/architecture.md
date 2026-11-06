# Receipts — Deployment Architecture

Target: AWS `ap-south-1` (Mumbai), funded by student credits.

- **Frontend** `receipts.<DOMAIN>` — private S3 → CloudFront
- **Backend** `api.receipts.<DOMAIN>` — single EC2 instance running Docker Compose
- **Database** PostgreSQL in Docker on that instance, named volume on encrypted EBS
- **DNS** Cloudflare · **IaC** Terraform · **CI/CD** GitHub Actions with AWS OIDC

Written for whoever deploys this. It assumes no familiarity with the codebase.

> **Supersedes an earlier ECS Fargate + ALB + RDS design.** That architecture
> was correct and cost ~$85/month, of which $52 was a NAT Gateway and an ALB
> doing very little. This one is ~$17. The trade-offs are real and are stated
> in [cost-estimate.md](./cost-estimate.md) rather than glossed.

---

## 1. What is being deployed

| Piece | Path | Runtime |
| --- | --- | --- |
| Record Server | `server/` | Node ≥22.12, Hono |
| Web client | `web/` | Vite 8 static build, React 19 |
| Contracts | `src/` | **Already on Sepolia. Not deployed by this pipeline.** |

### Request surface

| Method | Path | External dependency |
| --- | --- | --- |
| GET | `/health` | database |
| POST | `/api/world-id/request` | none (local signing) |
| POST | `/api/reviews/verify` | **World ID Portal** (paid) |
| POST | `/api/reviews/prepare` | database |
| POST | `/api/reviews/attest` | Ethereum RPC (ERC-1271 wallets only) |
| GET | `/reviews/:feedbackHash` | database |
| GET | `/api/agents/:agentId/reputation` | **Ethereum RPC** |
| POST | `/api/reputation/simulate` | none (pure computation) |

Two outbound dependencies matter: `developer.world.org` and the Ethereum RPC.
Both are plain HTTPS egress.

---

## 2. Topology

```
                   Cloudflare DNS  (both records grey-clouded)
                            │
        ┌───────────────────┴────────────────────┐
        │                                        │
 receipts.<DOMAIN>                      api.receipts.<DOMAIN>
        │                                        │
   CloudFront                              EC2 t4g.small  (public subnet, EIP)
        │ OAC                              ┌─────────────────────────────┐
        ▼                                  │ Caddy :443  (TLS, ACME)     │
   S3 (private)                            │      │ reverse proxy        │
   no website hosting                      │      ▼                      │
                                           │ api  127.0.0.1:8080         │
                                           │      │ docker network       │
                                           │      ▼                      │
                                           │ postgres  (no host port)    │
                                           │      └─ volume → EBS (enc.) │
                                           └─────────────────────────────┘
                                                      │
                                           egress: World ID, RPC, ECR
```

### Three layers of containment on one host

1. **PostgreSQL publishes no host port.** It is reachable only on the Docker
   network. Nothing outside the `api` container can address it, regardless of
   what the security group says.
2. **The API binds `127.0.0.1:8080`.** Not `0.0.0.0`. It is unreachable from
   outside the instance except through Caddy.
3. **The security group opens 80, 443 and SSH-from-one-IP.** Port 8080 is
   never opened, so a mistake in Caddy's config cannot expose the API without
   TLS.

Each layer is independent: two would have to fail together for the database
to be exposed.

### Why the instance is in a public subnet

A private subnet would need a NAT Gateway for the two outbound dependencies
in §1. That is **$34/month to avoid giving one instance a public IP** on a
deployment whose entire budget is credits. The exposure is managed by the
security group and the three layers above instead.

This is a cost decision with a security cost, not a free lunch. The upgrade
path — private subnet plus NAT — changes nothing else in this design.

---

## 3. Backend

`docker-compose.prod.yml` at the repository root. Two services.

**Dependency ordering matters.** `api` waits on `postgres`'s *healthcheck*,
not merely on the container existing:

```yaml
depends_on:
  postgres:
    condition: service_healthy
```

Without it the API starts first, fails to connect, and `restart: unless-stopped`
masks a real configuration error as a slow start.

### Configuration

Non-secret values are plain compose environment entries. Four secrets come
from `/opt/receipts/.env.prod`, `chmod 600`, root-owned, populated from
Secrets Manager on the instance (never committed, never in Terraform state):

`RECORD_SERVER_PRIVATE_KEY`, `WORLD_SIGNING_KEY`, `RPC_URL`, `POSTGRES_PASSWORD`.

`RPC_URL` is a secret because a JSON-RPC URL commonly embeds an API key. The
application already redacts it from logs.

Two variables are **required in production and default to off in code**, so
compose sets them explicitly:

| Variable | Why it must be set |
| --- | --- |
| `CORS_ALLOWED_ORIGINS` | App and API are different origins; unset means every browser call fails |
| `TRUST_PROXY` | `true` behind Caddy, so rate limiting sees the real client address |

### TLS

Caddy on the host, automatic ACME certificates, automatic renewal.

```
api.receipts.<DOMAIN> {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy is chosen over nginx + certbot purely because that four-line file is the
entire TLS story. The Cloudflare record must be **grey-clouded** or ACME
HTTP-01 validation cannot reach the instance.

### Graceful shutdown

Already implemented in `server.ts`: `SIGTERM` closes the listener, then the
database, then exits. Compose `stop_grace_period: 30s` gives in-flight
requests time to finish before `SIGKILL`.

The Dockerfile runs `node dist/server.js` directly rather than `npm start` —
npm would sit between Docker and the process and swallow the signal.

---

## 4. Frontend

The Vite build **inlines every `VITE_` variable at build time**. One
consequence governs the whole pipeline:

> There is no runtime configuration. A bundle belongs to the environment it
> was built for. Promoting a staging build to production is not possible
> without rebuilding.

So CI builds per environment and uploads to that environment's bucket.

The bucket is private with **no website hosting**; CloudFront reaches it via
an Origin Access Control and the bucket policy admits only that distribution.
A public bucket would make the distribution bypassable.

**SPA routing:** the app uses `BrowserRouter`, so `/agents/11265` is not an S3
key. CloudFront maps 403 and 404 to `/index.html` with status 200. Without
those two rules every deep link and every refresh 404s.

| Path | Cache-Control | Reason |
| --- | --- | --- |
| `/assets/*` | `max-age=31536000, immutable` | Vite content-hashes the filenames |
| `/index.html` | `no-cache` | must re-resolve to see a new bundle |

Because of that pairing, a deploy needs exactly one invalidation path:
`/index.html`. `/*` is slower and billable past 1,000 paths per month.

---

## 5. Persistence

PostgreSQL 16 in Docker, named volume `postgres-data` on the instance's
encrypted gp3 root volume.

**The volume survives** container replacement, `docker compose down`, and
instance reboot. **It does not survive** instance termination. Durability
therefore comes from two independent mechanisms, not from the volume:

| Mechanism | Covers | Does not cover |
| --- | --- | --- |
| Daily EBS snapshot (DLM, 7-day) | instance loss | a bad migration — the snapshot may be mid-write |
| Nightly `pg_dump` to S3 | logical corruption, bad migrations | the minutes since the last dump |

Neither alone is sufficient. See [runbook.md](./runbook.md) §5.

The migration from SQLite is **not done yet** and is the main outstanding
work. See [postgres-migration.md](./postgres-migration.md) — the headline is
that `better-sqlite3` is synchronous, so every `db/*.ts` function becomes
`async`, and `BEGIN IMMEDIATE` has no PostgreSQL equivalent.

---

## 6. Observability

| Signal | Destination |
| --- | --- |
| Container stdout/stderr | json-file driver, 10 MB × 3 rotation, shipped to CloudWatch by the agent |
| Instance metrics | CloudWatch (CPU, status checks); disk needs the agent |

Alarms worth having on day one, each tied to a failure this system produces:

| Alarm | Catches |
| --- | --- |
| Instance status check failed | host or hypervisor failure |
| CPU > 80% for 10 min | runaway or undersized |
| **Disk > 80%** | **the likeliest real outage** — PG data plus images on one 30 GB volume |
| `/health` from an external checker | app down while the instance looks healthy |

The application logs error **names**, never messages, so a thrown error
carrying a file path or an RPC URL cannot reach CloudWatch. Preserve that
when adding logging.

---

## 7. What this architecture does not provide

Stated so nobody assumes otherwise:

- **No redundancy.** One instance. Reboot, instance failure or a bad deploy is
  downtime, and recovery is manual.
- **No managed database.** No automated point-in-time recovery, no failover,
  no managed minor-version upgrades. Those are the things RDS's $15/month buys.
- **No horizontal scaling.** Rate limiting is per-process in memory
  (`middleware/rateLimit.ts`), so a second instance would double the effective
  limit. It needs Redis before scaling out.
- **No WAF.**

---

## 8. Cross-references

- [postgres-migration.md](./postgres-migration.md) — the outstanding work
- [security-checklist.md](./security-checklist.md) — findings and what was fixed
- [cost-estimate.md](./cost-estimate.md) — ~$17/month and why
- [runbook.md](./runbook.md) — deploy, backup, restore, rollback
- [`infrastructure/terraform/`](../../infrastructure/terraform/)

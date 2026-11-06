# Production Security Audit

Findings from reading `server/src` and `web/src`, ordered by severity.
Each item states what was checked, what was found, and what must change.

**ID key:** `S-n` severity-ranked finding. `OK-n` verified-good, recorded so a
later change does not quietly undo it.

---

## Blocking

### S-1 — No CORS middleware — **FIXED**

Was: `grep -rn "cors" server/src` returned nothing, so every `/api/*` call
from `receipts.<DOMAIN>` to `api.receipts.<DOMAIN>` would have been blocked.
Invisible in development because Vite proxies the API onto its own origin.

**Implemented** in `app.ts` using `hono/cors`, scoped to `/api/*`, driven by
`CORS_ALLOWED_ORIGINS`. `env.ts` validates each entry as a bare http(s)
origin and **rejects `*` outright**, because these endpoints spend a World ID
verification on an unauthenticated request. Unset means no CORS middleware is
mounted at all, which is correct behind the dev proxy.

`/reviews/:feedbackHash` is deliberately outside the scope: it is published
content meant to be fetched from anywhere.

Tests: `test/middleware.test.ts` — wildcard rejected, path-bearing entry
rejected, non-absolute entry rejected, default empty.

Original finding follows for the record.

The frontend will be served from `receipts.<DOMAIN>` and the API from
`api.receipts.<DOMAIN>`. Every `/api/*` call will be blocked by the browser.
Invisible in development because Vite proxies the API onto its own origin.

**Required.** Add `hono/cors` with an **explicit allow-list** from a new
`CORS_ALLOWED_ORIGINS` variable (comma-separated), validated in `env.ts`
alongside the others:

```ts
app.use('/api/*', cors({
  origin: env.corsAllowedOrigins,   // never '*'
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['content-type'],
  maxAge: 86_400,
}));
```

`origin: '*'` must not be used. The API performs state-changing operations
(spending a World ID verification, consuming a challenge) on unauthenticated
requests, so any origin being able to call it is a real exposure.

`GET /reviews/:feedbackHash` is published content and may stay open; scope the
middleware to `/api/*` so it does.

### S-2 — No rate limiting — **FIXED**

**Implemented** in `middleware/rateLimit.ts`: fixed-window per-client
counters, mounted by `server.ts` with `DEFAULT_RATE_LIMITS` (global 120/min;
`/api/reviews/verify` 10/min; `/api/agents` 30/min). Returns 429 with
`Retry-After` and advertises `RateLimit-*` headers.

Client identity is the **last** `X-Forwarded-For` hop and only when
`TRUST_PROXY=true` — the last entry is the one the proxy appended and the
only one it can vouch for. Taking the first, the usual mistake, makes the
limiter trivially bypassable. A regression test covers this and fails if the
logic is reverted.

**Known limitation:** counters are per process and in memory. Correct for one
instance; a second would double the effective limit. Needs Redis before
scaling out. Recorded in architecture.md §7.

Original finding follows for the record.

| Route | Exposure |
| --- | --- |
| `POST /api/reviews/verify` | relays to the **paid** World ID Portal |
| `GET /api/agents/:id/reputation` | scans logs across an RPC provider quota |

An unauthenticated open relay to a third-party paid API is a cost and
reputation problem before it is a load problem.

**Required.** Per-IP limiting at the application layer, read from
`X-Forwarded-For` (the ALB sets it; trust only the last hop). Suggested
starting points: `verify` 10/min, `reputation` 30/min, global 120/min.

### S-3 — SQLite cannot enforce the uniqueness rule across processes — **OPEN**

Still the main outstanding work. Note it is **less acute** under the EC2
design than it was under Fargate: one instance means one process means the
`UNIQUE (agent_id, nullifier)` constraint does hold today. It becomes a
correctness problem the moment a second instance exists, and it remains the
reason PostgreSQL is required before scaling out.

See [database-migration.md §1](./database-migration.md). With two Fargate
tasks the `UNIQUE (agent_id, nullifier)` constraint is per-task, so one human
can obtain two signed attestations for one agent. The on-chain
`NullifierRegistry` rejects the second submission, so **no invalid review can
land** — but the server will have signed something unusable and the user pays
gas to discover it.

**Required.** PostgreSQL, or a hard limit of one task.

---

## Important

### S-4 — No security headers — **FIXED**

**Implemented** in `middleware/securityHeaders.ts`, applied to every response
including errors and 429s: `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Cross-Origin-Resource-Policy`, a restrictive
`Content-Security-Policy` and `Permissions-Policy`.

`Strict-Transport-Security` is set **only when the request arrived over
HTTPS** (direct, or reported by `X-Forwarded-Proto`). Sending it over plain
HTTP is meaningless, and in local development it would pin `localhost` to
HTTPS in the browser for a year.

Original finding follows for the record. `GET /reviews/:feedbackHash` returns
**reviewer-authored content**, which is the one genuinely untrusted byte
stream the server emits.

Mitigations already present and worth keeping (`routes/reviewContent.ts`):
`Content-Type: text/plain; charset=utf-8`, `X-Content-Type-Options: nosniff`,
`Content-Disposition: inline`.

**Required additionally:** `Strict-Transport-Security`,
`Content-Security-Policy: default-src 'none'` on that route specifically, and
`Referrer-Policy: no-referrer`. CloudFront should add HSTS for the frontend.

### S-5 — `verifyDeployment` exits the process on RPC failure

`server.ts` calls `process.exit(1)` when the RPC is unreachable or the signer
does not match. The behaviour is **correct** — a server that cannot produce
acceptable attestations must not serve — but under ECS a transient RPC outage
becomes a crash-looping task.

**Required:** no code change, but an alarm on ECS task restart count and ALB
unhealthy host count, so a crash loop is diagnosed as an RPC outage rather
than a deploy failure. Document it in the runbook (done).

### S-6 — Frontend RPC endpoint is public by construction

`VITE_RPC_URL` is inlined into the bundle. Anyone can read it.

**Required:** the frontend endpoint must be key-free or scoped read-only and
origin-restricted. It must **never** be the same `RPC_URL` the server uses,
which is treated as a secret precisely because it may embed a key. The
`.env.example` says so; the deployment must honour it.

---

## Verified good — do not regress

### OK-1 — Secrets are never logged

`env.ts` declares `SECRET_ENV_KEYS` and `redactEnv()` replaces
`WORLD_SIGNING_KEY`, `RECORD_SERVER_PRIVATE_KEY` and `RPC_URL` with
`[redacted]`. The startup banner uses it. Validation errors name the variable
and the expected shape, never the observed value.

`app.ts` returns a fixed `{ error: 'internal_error' }` and logs `err.name`
only — deliberately, because a thrown error can carry a file path or an
environment value. **Keep this when adding logging.**

### OK-2 — Signing keys never reach the browser

Verified: `grep -rn "PRIVATE_KEY\|SIGNING_KEY" web/src` returns nothing. The
frontend holds no key. The Record Server signs attestations; the user's wallet
signs the authorization; the browser orchestrates and never possesses either.

### OK-3 — Environment validation is strict and fails closed

`loadEnv()` collects **all** issues before throwing, so one boot reports every
problem. Required variables have no defaults where a wrong value would be a
security fault. `WORLD_SIGNING_KEY` is validated as a secp256k1 scalar via
`privateKeyToAccount` at construction, so a bad key fails at boot rather than
on the first request.

### OK-4 — Request validation is thorough

Every route validates before acting. Notable:

- `agentId` must be a **decimal string**; a JSON number is rejected outright
  because it has already lost precision. Leading zeros are rejected so `"042"`
  and `"42"` cannot produce two nullifier scopes for one agent.
- Signature length is capped at 4 KiB **before** any hashing or RPC call.
- Review content is capped at 16 KiB before it is hashed.
- `feedbackHash` must match `^0x[0-9a-fA-F]{64}$`.

### OK-5 — No client-supplied value reaches a signature

`/api/reviews/attest` takes only a challenge id and a signature. Every field
of the attestation is rebuilt from stored state, so there is no field a caller
could restate differently from what the wallet signed. `feedbackURI` is
derived from the `feedbackHash` rather than accepted.

The reputation engine derives weights and review types from on-chain data
only. The one endpoint that accepts review data,
`POST /api/reputation/simulate`, is separate by design, marked
`simulated: true`, and returns **no evidence hash**.

### OK-6 — Ordering in the review flow fails safe

The signature is verified before the challenge is consumed, and the challenge
is consumed before the Record Server signs. A rejected signature therefore
leaves the challenge spendable, and the server's key is never applied to
anything the reviewer has not demonstrably authorized.

`verification_unavailable` is reported as 503 and distinguished from a
rejection, so a World ID outage does not burn a user's verification.

### OK-7 — Graceful shutdown is implemented

`SIGINT`/`SIGTERM` close the listener and the database before exit. Works with
ECS `stopTimeout` and ALB deregistration delay.

---

## Deployment-specific requirements

| Control | Requirement |
| --- | --- |
| PostgreSQL port | **never** published to the host; reachable only on the Docker network |
| API port | binds `127.0.0.1:8080`; Caddy is the only path in |
| Security group | 80, 443, and SSH from one address. **Never** 8080, never 5432 |
| IMDS | v2 required (`http_tokens = "required"`) — this instance makes outbound requests to a third party |
| --- | --- |
| Secrets at rest | Secrets Manager, KMS-encrypted, injected by ECS as `secrets` — never in the task definition |
| Secrets in CI | OIDC role assumption only. **No long-lived AWS keys in GitHub.** |
| RDS | `publicly_accessible = false`, storage encrypted, in a subnet with no NAT route |
| ECS tasks | private subnets, no public IP, security group inbound from the ALB only |
| S3 | all four public-access blocks on; bucket policy grants only the CloudFront OAC |
| ALB | HTTPS only, HTTP → HTTPS redirect, TLS 1.2+ policy |
| IAM | task execution role may read **only** the four secret ARNs; task role has no AWS permissions at all |
| Logs | 30-day retention; verify no secret ever appears (OK-1 is the control) |

---

## Pre-deploy checklist

- [ ] CORS allow-list configured, `*` not used (S-1)
- [ ] Rate limiting live on `verify` and `reputation` (S-2)
- [ ] PostgreSQL migrated, concurrency tests pass unmodified (S-3)
- [ ] Security headers added (S-4)
- [ ] Alarms cover the crash-loop case (S-5)
- [ ] Frontend RPC URL is key-free and distinct from the server's (S-6)
- [ ] `WORLD_ENVIRONMENT` confirmed against the Developer Portal
- [ ] RDS not publicly accessible — verified in the plan, not assumed
- [ ] No secret in any Terraform `.tf` file or state
- [ ] `grep -rn "PRIVATE_KEY\|SIGNING_KEY" web/dist` returns nothing

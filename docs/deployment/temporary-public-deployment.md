# Temporary public deployment (Cloudflare Quick Tunnel)

A stopgap while the AWS account is blocked by service-subscription and SCP
restrictions. It puts the **existing** local production stack on a public
HTTPS URL with no new infrastructure, no domain and no AWS.

```
Internet ──HTTPS──▶ Cloudflare edge ──▶ cloudflared (this Mac) ──▶ Caddy :80
                                                                     ├─ /api/*, /reviews/*, /health ──▶ api:8080
                                                                     └─ everything else ──▶ /srv (web/dist, SPA)
```

**Current URL:** `https://workflow-vat-songs-inches.trycloudflare.com`

> A Quick Tunnel URL is **ephemeral**. It changes every time `cloudflared`
> restarts, and it dies when this Mac sleeps or the process is killed. See
> [After a tunnel restart](#after-a-tunnel-restart) — two values must be
> updated and the API restarted, or the app breaks in ways that look like
> CORS bugs.

## Why one hostname

The frontend is built with `VITE_API_BASE_URL` **empty**, so it calls the API
with relative paths (`/api/...`). Caddy serves both the bundle and the API on
the same origin. That buys three things:

- no cross-origin requests, so no CORS preflight in the normal path;
- the bundle does not need to know the public hostname at build time — which
  matters because a Quick Tunnel's URL does not exist until it starts;
- no second tunnel or subdomain to manage.

## Local services

| Service | Image | Host binding | Public? |
|---|---|---|---|
| `caddy` | `caddy:2.8-alpine` | `0.0.0.0:80`, `:443` | **yes**, via the tunnel |
| `api` | `local/receipts-api:dev` | `127.0.0.1:8080` | no — loopback only |
| `postgres` | `postgres:16-bookworm` | **none** | no — compose network only |

`cloudflared` targets `http://localhost:80` only, so the API port and the
database are unreachable from the internet even though the API is bound on
the host.

## Start

Assumes the stack is already up. If not:

```bash
cd ~/receipt
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

Build the frontend for same-origin use (note the empty API base URL):

```bash
cd web
VITE_API_BASE_URL= \
VITE_CHAIN_ID=11155111 \
VITE_REVIEW_GATEWAY_ADDRESS=0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD \
VITE_RECEIPT_SETTLER_ADDRESS=0xC3AA7a2F43d83680f9E0B97e0Eb4fD01E421ceDe \
VITE_NULLIFIER_REGISTRY_ADDRESS=0xBA688eDFd43719378b8D3dC333C858e8d5720a4C \
VITE_IDENTITY_REGISTRY_ADDRESS=0x8004A818BFB912233c491871b3d84c89A494BD9e \
VITE_REPUTATION_REGISTRY_ADDRESS=0x8004B663056A597Dffe9eCcC1965A193B7388713 \
VITE_GATEWAY_DEPLOY_BLOCK=12064002 \
VITE_EXPLORER_URL=https://sepolia.etherscan.io \
npm run build
cd ..
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d caddy
```

Start the tunnel:

```bash
brew install cloudflared                      # once
cloudflared tunnel --url http://localhost:80 --no-autoupdate
```

It prints the URL. To keep it out of the foreground:

```bash
cloudflared tunnel --url http://localhost:80 --no-autoupdate > /tmp/cloudflared.log 2>&1 &
grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/cloudflared.log | head -1
```

No credential or token is involved: a Quick Tunnel is anonymous, which is
also why it cannot be given a stable name.

## After a tunnel restart

The URL changes. Two values are pinned to it and **must** be updated:

```bash
U=https://<new>.trycloudflare.com
cd ~/receipt
sed -i '' "s|^CORS_ALLOWED_ORIGINS=.*|CORS_ALLOWED_ORIGINS=$U|" .env.prod
sed -i '' "s|^REVIEW_CONTENT_BASE_URL=.*|REVIEW_CONTENT_BASE_URL=$U|" .env.prod
chmod 600 .env.prod
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d api
```

- `CORS_ALLOWED_ORIGINS` — a stale value does not break same-origin GETs, so
  the app *looks* fine until a cross-origin preflight fails.
- `REVIEW_CONTENT_BASE_URL` — **this one is not cosmetic.** It is baked into
  the signed `feedbackURI` of every attestation. A review submitted while
  this points at a dead URL carries a permanently unresolvable evidence link.
  Attestations already on chain are not rewritten by changing it.

The frontend does **not** need rebuilding: it uses relative paths.

## Stop

```bash
pkill -f 'cloudflared tunnel'                  # take the site offline
docker compose -f docker-compose.prod.yml --env-file .env.prod stop
```

Never `docker compose down -v` — that destroys the PostgreSQL volume and
with it the database.

## Checks

```bash
U=https://workflow-vat-songs-inches.trycloudflare.com
curl -i "$U/health"                            # API
curl -s -o /dev/null -w '%{http_code}\n' "$U/" # frontend
curl -s "$U/api/agents/11265/reputation"       # reputation
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `502` from Cloudflare | Caddy is down, or the tunnel points at the wrong port | `docker compose ... ps`; restart the tunnel against `http://localhost:80` |
| Site loads, every API call fails | `cloudflared` is up but the API container is not | `docker compose ... up -d api` |
| CORS errors in the console | tunnel URL changed, `.env.prod` still names the old one | see [After a tunnel restart](#after-a-tunnel-restart) |
| Deep link 404s | `web/dist` is not mounted, or `index.html` is missing | rebuild the frontend, `up -d caddy` |
| `/health` returns 503 | PostgreSQL unreachable | `docker compose ... logs postgres` |
| Reputation returns 503 | RPC read failed | `docker compose ... logs api \| grep '\[reputation\]'` |
| Tunnel dies overnight | the Mac slept | restart the tunnel, then update the two values above |

## Security limitations

Accepted for a temporary demo; each is a real reason this is not production.

1. **Rate limiting is effectively global.** Every public visitor arrives via
   the same `cloudflared` hop, so the last `X-Forwarded-For` entry the API
   trusts is identical for everyone. The 120 requests/minute bucket is shared
   by the whole internet rather than applied per client.
2. **The URL is unauthenticated and guessable-by-sharing.** Anyone with the
   link reaches the app. There is no WAF and no bot protection.
3. **Availability is one laptop.** Sleep, a network change or a process
   restart takes the site down and changes its address.
4. **Source maps are served.** `web/dist` ships `.map` files (~4.5 MB), so
   the frontend source is readable. No secrets are in them — every `VITE_*`
   value is public by design — but remove `sourcemap: true` from
   `vite.config.ts` if that is unwanted.
5. **Cloudflare terminates TLS**, so plaintext traffic exists between the
   edge and this machine via the tunnel (itself an encrypted outbound
   connection, so this is not an open path).

What is **not** a limitation: PostgreSQL publishes no host port, the API is
bound to loopback only, there are no admin/debug/metrics endpoints, `/health`
discloses nothing but status and uptime, and every unmatched path returns the
SPA rather than a file from disk.

## Replacing this with permanent hosting

The architecture was built for AWS and nothing here is throwaway except the
tunnel itself.

1. Unblock the AWS account (service subscriptions + SCP), or use an account
   that is already active.
2. `terraform apply` the backend; point `api.receipts.<domain>` at the EIP,
   grey-clouded, and set `CADDY_SITE_ADDRESS` to that hostname so Caddy
   issues a real certificate.
3. Build the frontend with `VITE_API_BASE_URL=https://api.receipts.<domain>`
   and deploy it to the S3 + CloudFront module; set `CORS_ALLOWED_ORIGINS`
   to `https://receipts.<domain>`.
4. Set `REVIEW_CONTENT_BASE_URL` to the permanent API origin **before** any
   review you intend to keep is submitted.
5. Stop the tunnel.

The Caddyfile's static-file handler is harmless on AWS: CloudFront serves the
frontend there, and the API prefixes are matched first regardless.

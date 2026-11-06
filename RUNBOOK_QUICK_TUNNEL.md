# Runbook: Cloudflare Quick Tunnel recovery (Receipts demo)

Scope: the existing local deployment only. Docker Compose project `receipts`, run from `/Users/parthdagia/receipt` with `docker-compose.prod.yml`, exposed through a Cloudflare **Quick Tunnel** (`cloudflared`).

This runbook only contains commands. **Nothing in it was executed except the read-only checks marked 🟢.** No file, container, tunnel or DNS record was changed while writing it.

## Command legend

| Mark | Meaning |
|---|---|
| 🟢 | Read-only. Safe at any time, including mid-demo. |
| 🟡 | Changes local state but does not interrupt service (starts a process, adds a tag, makes a backup). |
| 🔴 | **Potentially disruptive.** Interrupts service, edits production configuration, or can lose data if misused. Do not run during a live demo unless you are in the recovery procedure. |

All commands assume:

```bash
setopt interactive_comments   # zsh only: lets you paste the inline "# ..." comments below without breaking commands
cd /Users/parthdagia/receipt
dc() { docker compose --env-file .env.prod -f docker-compose.prod.yml "$@"; }
```

`dc` is a shell function, not a string variable, because zsh does not split an unquoted `$VARIABLE` into words. Everywhere below, `dc ...` means that full command.

`--env-file .env.prod` is required on **every** compose command. Without it compose reads `.env`, the `:?` variables are empty, and the command aborts (or, for `up`, could start with the wrong values).

## 0. State as observed (read-only, at time of writing)

| Item | Observed |
|---|---|
| Tunnel URL | `https://campbell-stylus-berkeley-steal.trycloudflare.com` |
| cloudflared | PID `49080`, command `cloudflared tunnel --url http://localhost:80 --no-autoupdate`, one foreground process. **Its stdout is the terminal `/dev/ttys002`, not a file.** Closing that terminal or pressing Ctrl-C ends the tunnel, and its logs exist only in that terminal's scrollback. |
| cloudflared local metrics | `127.0.0.1:20241`. `/ready` returned `readyConnections: 1`. `/quicktunnel` returned the hostname above. |
| Containers | `receipts-postgres-1` (healthy), `receipts-api-1` (healthy, `127.0.0.1:8080`), `receipts-caddy-1` (`:80`, `:443`). All have `restart: unless-stopped`. |
| Volumes | `receipts_postgres-data` (the database), `receipts_caddy-data`, `receipts_caddy-config` |
| `.env.prod` | `REVIEW_CONTENT_BASE_URL` and `CORS_ALLOWED_ORIGINS` both equal the tunnel origin above. `ECR_REGISTRY=local`, `IMAGE_TAG=integration-a96e4ed-20261106` (was `dev` before the 2026-11-06 integration deployment; `local/receipts-api:dev` is kept as the rollback image). |
| Public checks | `/` 200, `/health` 200 with `database: ok`, `/agents/1` (deep link) 200, `/reviews/<unknown hash>` 404 (JSON, not HTML), CORS preflight from the tunnel origin echoed the origin and a foreign origin got no allow-origin header. |

### Two facts that change how you should recover

1. **The running API image is older than the merged code.** `local/receipts-api:dev` was built `2026-11-05T23:47 +05:30`, and `GET /api/agents/1/reputation` reports spec `receipts-reputation/1.0` with no `tiers`, and `GET /api/reviews/wallet/status` returns `not_found`. The served frontend (`web/dist`, built 2026-11-06 06:00) is the merged build. The UI tolerates this (the wallet option stays hidden and the tiers panel is skipped), but it is a **version skew**.
   **Consequence:** never add `--build` to a recovery command. Rebuilding would swap in the merged server code, which has not been run in this deployment. All commands below use `--no-build`, which reuses the existing image.
2. **The frontend bundle is hostname-independent.** It calls `/api`, `/reviews` and `/health` on its own origin (`VITE_API_BASE_URL` is empty) and the bundle contains no `trycloudflare` string. A new hostname needs **no frontend rebuild and no Caddy change.** Caddy listens on `:80` and does not know the hostname.

## 1. Check tunnel health without restarting anything

All 🟢.

```bash
T=https://campbell-stylus-berkeley-steal.trycloudflare.com

# Is the process alive, and for how long?
ps -o pid,etime,args= -p 49080

# Does cloudflared itself think it is connected? (port: see lsof if 20241 is not it)
curl -s -m 5 http://127.0.0.1:20241/ready          # expect {"status":200,"readyConnections":>=1,...}
curl -s -m 5 http://127.0.0.1:20241/quicktunnel    # expect {"hostname":"campbell-stylus-berkeley-steal.trycloudflare.com"}
lsof -nP -p 49080 -a -iTCP -sTCP:LISTEN            # shows the metrics port if it is not 20241

# End to end through the public URL (GET only)
curl -s -o /dev/null -w "root   %{http_code} %{time_total}s\n" -m 10 $T/
curl -s -m 10 $T/health                            # expect {"status":"ok",...,"checks":{"database":"ok"}}
```

If `/quicktunnel` ever returns a hostname different from the one in `.env.prod`, the tunnel was restarted and you are in [section 4](#4-recovery-hostname-changed).

## 2. Is it cloudflared, Caddy, the API or the database?

Run the checks from the outside in. The first one that fails is the broken layer. All 🟢.

```bash
ps -p 49080 >/dev/null && echo "cloudflared: process up" || echo "cloudflared: process GONE"
curl -s -o /dev/null -w "tunnel public /health : %{http_code}\n" -m 10 $T/health
curl -s -o /dev/null -w "caddy   local :80     : %{http_code}\n" -m 5  http://localhost/health
curl -s -o /dev/null -w "api     local :8080   : %{http_code}\n" -m 5  http://127.0.0.1:8080/health
dc ps
```

| Process | `/ready` | public `/health` | local `:80` | local `:8080` | Diagnosis | Go to |
|---|---|---|---|---|---|---|
| gone | n/a | fails or serves a Cloudflare error page | 200 | 200 | **cloudflared is down.** The stack is fine. | 3, then 4 |
| up | `readyConnections` 0 | fails | 200 | 200 | **cloudflared up but disconnected** (network). It reconnects by itself with the **same** hostname. Wait 30 to 60 s and recheck. | 1 |
| up | ok | 502 or 5xx | 502 | fails | **API down.** Caddy answers but cannot reach it. | 5 |
| up | ok | fails | fails | fails | Caddy and API both unreachable: Docker itself (Docker Desktop stopped?). | 7 |
| up | ok | 200 but `database` is not `ok` | | 200 | **Database problem.** `docker logs receipts-postgres-1 --tail 50` (🟢). | 7 |

Look at why a container is unhealthy with 🟢 `docker logs receipts-api-1 --tail 50` and `docker inspect receipts-api-1 --format '{{.State.Status}} {{.State.Health.Status}} exit={{.State.ExitCode}}'`. The API redacts secrets in logs by design, but do not paste logs anywhere public.

An API container that crashed is restarted automatically (`restart: unless-stopped`). Only act if it stays down.

## 3. Why restarting a Quick Tunnel can give a different hostname

A Quick Tunnel is the account-less, throwaway mode of `cloudflared` (`cloudflared tunnel --url ...`). When the process starts it asks Cloudflare for a new temporary tunnel, and Cloudflare assigns a **random** `*.trycloudflare.com` name that exists only for that process. Nothing is saved: there is no account, no tunnel ID you own and no DNS record you control, so there is nothing to bind the old name to. When the process exits, that tunnel is gone and the name is not reserved for you. Starting a new process creates a new tunnel and so, in practice, a new name.

What changes the hostname:

- the `cloudflared` process exits for any reason: crash, Ctrl-C, closing `/dev/ttys002`, reboot, logout;
- the Mac sleeps or loses network for long enough that the connection is dropped and the process exits.

What does **not** change it: a brief network blip while the process stays alive (it reconnects with the same name), and restarting Docker containers (the tunnel only points at `localhost:80`).

Quick Tunnels also have no uptime guarantee, which is why this runbook has a contingency plan. A stable hostname would need a named tunnel and DNS, which is **out of scope here and not recommended to attempt during the demo**.

This section describes general Quick Tunnel behaviour. I did not restart the tunnel to demonstrate it.

## 4. Recovery: hostname changed

### 4.0 Before you touch anything (once, ahead of the demo)

```bash
# 🟡 Back up the env file (it holds secrets: never commit or share the backup)
cp -p .env.prod ".env.prod.bak-$(date +%Y%m%d-%H%M%S)"     # *.bak is covered by the .env.* ignore rule
# 🟡 Keep a named copy of the API image, so a missing :dev tag cannot force a rebuild
docker tag local/receipts-api:dev local/receipts-api:demo-backup
# 🟢 Note the database volume identity, to prove later that it was not recreated
docker volume inspect receipts_postgres-data --format '{{.Name}} created {{.CreatedAt}}'
# 🟢 Prevent the Mac from sleeping while the tunnel runs (🟡 starts a small process)
caffeinate -dimsu -w 49080 &
```

### 4.1 Start a new tunnel (🟡, only if cloudflared is gone)

Run it in a terminal you will **leave open**, and run nothing else there:

```bash
cloudflared tunnel --url http://localhost:80 --no-autoupdate
```

This starts a new process and creates a new public URL. It does not touch containers. The new hostname is printed in the banner (`https://<words>.trycloudflare.com`). You can also read it once it is up:

```bash
curl -s -m 5 http://127.0.0.1:20241/quicktunnel     # port may differ: see lsof in section 1
```

Do **not** start a second cloudflared while the first is alive. Check `pgrep -fl cloudflared` first.

### 4.2 Set the new hostname (🔴 edits the production env file)

Both values must be the **bare origin**: `https://`, the host, no trailing slash, no path, no query, no credentials. The server validates them at startup and **refuses to boot** on anything else.

| Variable | What it controls | Effect of leaving it stale |
|---|---|---|
| `REVIEW_CONTENT_BASE_URL` | The origin baked into every signed `feedbackURI` (`<origin>/reviews/<hash>`). It is part of the EIP-712 digest. | New attestations point at a dead host. Reviews that are later written on-chain keep that dead host in their on-chain URI **permanently**. |
| `CORS_ALLOWED_ORIGINS` | Browser origins allowed to call `/api/*`. | The app and API are served from one origin here, so same-origin calls may keep working, but this is untested. Keep it equal to the new origin anyway. |

```bash
NEW_HOST="<new-words>.trycloudflare.com"          # only the host, from the cloudflared banner
echo "$NEW_HOST" | grep -Eq '^[a-z0-9-]+(\.[a-z0-9-]+)*\.trycloudflare\.com$' || echo "BAD HOSTNAME, stop"

# 🔴 Edits .env.prod. Touches only these two keys. macOS sed.
sed -i '' -E "s#^(REVIEW_CONTENT_BASE_URL=).*#\1https://${NEW_HOST}#; s#^(CORS_ALLOWED_ORIGINS=).*#\1https://${NEW_HOST}#" .env.prod
chmod 600 .env.prod

# 🟢 Confirm exactly those two lines changed (prints only these keys, never secrets)
grep -E '^(REVIEW_CONTENT_BASE_URL|CORS_ALLOWED_ORIGINS)=' .env.prod
diff <(grep -vE '^(REVIEW_CONTENT_BASE_URL|CORS_ALLOWED_ORIGINS)=' .env.prod.bak-*) \
     <(grep -vE '^(REVIEW_CONTENT_BASE_URL|CORS_ALLOWED_ORIGINS)=' .env.prod) && echo "no other lines changed"
```

If more than one `.env.prod.bak-*` exists, point the `diff` at the specific backup file.

The values are inlined into the **container's** environment at creation. Editing the file does nothing to the running API until it is recreated.

### 4.3 Recreate only the API (🔴 brief API outage)

```bash
# 🔴 Recreates ONLY the api container. Expect a short window of 502s while it starts.
dc up -d --no-deps --no-build api
```

Why each flag matters:

| Flag | Reason |
|---|---|
| `api` (service name) | Limits the command to that one service. |
| `--no-deps` | Do not touch `postgres` (the API `depends_on` it). Postgres keeps running untouched. |
| `--no-build` | Reuse `local/receipts-api:dev`. Without it, compose may rebuild and swap in different server code (see section 0). |
| no `--force-recreate` | Compose recreates `api` anyway because its configuration changed (the two env values). It leaves unchanged services alone. |

Why the database survives: `receipts_postgres-data` is a **named volume** mounted by `postgres`. Recreating the `api` container never touches it, and this command does not touch `postgres` at all. Caddy is unaffected as well (no config change, no restart).

Then wait for health (🟢):

```bash
dc ps api                                           # wait for (healthy); start_period is 20 s
docker exec receipts-api-1 printenv REVIEW_CONTENT_BASE_URL CORS_ALLOWED_ORIGINS   # both must show the NEW origin; prints only these two
docker volume inspect receipts_postgres-data --format '{{.Name}} created {{.CreatedAt}}'   # must match the value from 4.0
```

What a recreate costs: the API process restarts, so in-memory rate-limit counters reset and any request in flight fails. World ID request nonces, verifications and signing challenges are stored in PostgreSQL and survive. An attestation issued before the change carries the **old** hostname in its `feedbackURI` and keeps it (still valid on-chain, but the URI points at the dead host).

### 4.4 If the API refuses to start after the edit

```bash
docker logs receipts-api-1 --tail 30     # 🟢 the error names the offending variable
# Roll back: 🔴 restore the file, recreate again
cp -p .env.prod.bak-<timestamp> .env.prod && chmod 600 .env.prod
dc up -d --no-deps --no-build api
```

## 5. Recovery: API down, hostname unchanged

No env change is needed. Check why first (🟢 `docker logs receipts-api-1 --tail 50`). If the container is stopped and not restarting itself:

```bash
# 🔴 Starts the api container only (brief outage if it was running; none if it is already healthy and unchanged)
dc up -d --no-deps --no-build api
```

If the logs show a configuration error, fix the value in `.env.prod` first (section 4.2), then run the command above.

## 6. Verification (all 🟢)

Replace `T` with the current origin (the new one after a hostname change).

```bash
T=https://<current-host>.trycloudflare.com

# Frontend: page and a deep link (the SPA fallback must serve index.html, not 404)
curl -s -o /dev/null -w "frontend /            %{http_code}\n" -m 10 $T/
curl -s -o /dev/null -w "frontend /agents/1    %{http_code}\n" -m 10 $T/agents/1
curl -s -m 10 $T/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1     # a bundle is referenced

# API health through the tunnel and locally
curl -s -m 10 $T/health                                     # {"status":"ok",...,"checks":{"database":"ok"}}
curl -s -o /dev/null -w "api local             %{http_code}\n" -m 5 http://127.0.0.1:8080/health

# CORS: the new origin must be echoed; a foreign origin must get NO access-control-allow-origin
curl -s -i -m 10 -X OPTIONS $T/api/reviews/prepare -H "Origin: $T" \
  -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type" \
  | grep -i '^HTTP\|access-control-allow-origin'
curl -s -i -m 10 -X OPTIONS $T/api/reviews/prepare -H "Origin: https://evil.example" \
  -H "Access-Control-Request-Method: POST" | grep -i 'access-control-allow-origin' || echo "foreign origin refused (correct)"

# Review-content routing: /reviews/* must reach the API (a JSON 404), not the SPA (which would return 200 HTML)
curl -s -w "\n-> %{http_code}\n" -m 10 $T/reviews/0x0000000000000000000000000000000000000000000000000000000000000001
# expect {"error":"not_found"} and 404. If you see 200 and HTML, the route is being served by the frontend fallback.

# What the running API will sign into feedbackURI (must equal the current origin)
docker exec receipts-api-1 printenv REVIEW_CONTENT_BASE_URL

# A positive content check needs a stored hash. Only if the table has rows (read-only):
docker exec receipts-postgres-1 psql -U receipts -d receipts -Atc "select feedback_hash from review_contents limit 1"
# then: curl -s -o /dev/null -w "%{http_code}\n" $T/reviews/<that hash>      # expect 200
```

The database user and name above are the compose defaults (`receipts` / `receipts`). If you changed `POSTGRES_USER` or `POSTGRES_DB` in `.env.prod`, use those.

Not verified end to end here: whether World ID or World App needs the hostname registered anywhere (for example allowed origins in the Developer Portal). Check that in the portal before the demo. I could not and did not test it.

## 7. Contingency plan if recovery fails during the demo

Decide quickly. In order:

1. **Retry the cheap path (under 2 minutes).** Sections 1 and 2, then 4.1 if cloudflared is gone. If the API is the problem, section 5.
2. **Demo from localhost.** Caddy serves the frontend and the API on the same origin at `http://localhost`, with no tunnel. Everything the browser needs works there, and CORS is not involved. `REVIEW_CONTENT_BASE_URL` still names the old tunnel host, so signed `feedbackURI`s would point at it. That does not affect what the UI displays, but **do not submit an on-chain review from a localhost demo with a stale base URL**, because the dead host would be written on-chain permanently.
3. **Use the recorded demo video** (ETHGlobal asks for 2 to 4 minutes, 720p or better, and rejects videos outside that length). Record it **before** any risky change, from a moment when everything is healthy. This is the real safety net.
4. **Show verifiable artefacts instead of the live site:** the passing test output (server 1230, web 24, Forge 279 passed and 9 skipped on the merged branch), the read-only on-chain checks from `DEMO.md` section 4, and the README. These need no tunnel.
5. **Another tunnel tool.** Not tested or documented here; do not choose this under pressure.

Say plainly, on the demo, which parts are live and which are recorded. Do not present the live deployment as running the merged code: the API image is the pre-merge build (section 0).

## 8. Never run these

| Command | Why |
|---|---|
| 🔴 `dc down -v`, `docker compose down --volumes` | Deletes `receipts_postgres-data`: all World ID verifications, challenges and review content. |
| 🔴 `docker volume rm receipts_postgres-data`, `docker volume prune`, `docker system prune --volumes` | Same. |
| 🔴 `dc down` (without `-v`) | Does not delete the volume, but stops everything, including Caddy, and is unnecessary for a hostname change. |
| 🔴 `dc up -d` (no service name), `dc up -d --force-recreate` | Touches more services than needed. Use the service-scoped command. |
| 🔴 `dc up -d --build ...`, `docker compose build` | Replaces the pre-merge API image with untested-in-deployment code (section 0). |
| 🔴 `dc restart postgres`, `docker restart receipts-postgres-1` | Interrupts the database for no benefit. |
| 🔴 `kill 49080` or closing `/dev/ttys002` | Ends the tunnel and changes the hostname. |
| Creating a named tunnel or touching DNS | Out of scope. |

## 9. Summary of potentially disruptive commands

| # | Command | Mark | What it disrupts |
|---|---|---|---|
| 1 | `cloudflared tunnel --url http://localhost:80 --no-autoupdate` (new process) | 🟡 | Creates a new public URL. Harmless to services, but it is the thing that changes the hostname. Never run it while the old process is alive. |
| 2 | `sed -i '' ... .env.prod` | 🔴 | Edits production configuration. No effect on the running API until the container is recreated. Back up first. |
| 3 | `dc up -d --no-deps --no-build api` | 🔴 | Recreates the API container. Brief outage, in-memory state reset, database untouched. |
| 4 | `cp -p .env.prod.bak-<ts> .env.prod` then command 3 | 🔴 | Rollback of the above. |
| 5 | `cp -p .env.prod ...bak`, `docker tag ...`, `caffeinate ... &` | 🟡 | Local changes only: a backup file, an image tag, a process. No service impact. |

Everything else in this runbook is 🟢 read-only.

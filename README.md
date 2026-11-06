# Receipts

Payment-bound, human-verified reviews for ERC-8004 agents, scored with a manipulation-resistant weighted median.

Built for ETHGlobal Mumbai 2026. Contracts target Ethereum Sepolia.

> **Read this first: what is and is not done.**
> This is a hackathon prototype. It has not been audited. Several things below are implemented and tested locally but are **not** live, and some planned things are **not built at all**. The [status table](#status-what-is-implemented-tested-and-live) is the source of truth.

## The idea

ERC-8004 gives AI agents an on-chain identity and a Reputation Registry that anyone can write feedback to. The registry's own summary is a plain mean, and anyone can submit unlimited feedback, so a handful of fresh addresses can move it. The repository includes a mainnet-fork experiment showing a naive mean moving from 50 to 77 with six synthetic reviewers (`test/AttackLab.t.sol`, `script/AttackLab.s.sol`). It is skipped by default and needs `RUN_FORK_TESTS=true` plus an RPC, and **it has not been re-run for this documentation**.

Receipts puts a gate in front of the registry and computes its own score:

1. **Gateway.** A `ReviewGateway` contract is the only writer of Receipts feedback. It accepts a review only with a signed attestation from a Record Server, so who may review is decided before anything reaches the registry.
2. **Three kinds of review, labelled honestly** (below).
3. **A weighted median** over verified human reviews, with a minimum of five distinct humans before any score is published. A median is not moved by an attacker holding less than half the weight, unlike a mean.

## Review types

| Type | On-chain `reviewType` / tag2 | What it proves | Counts toward the human score? |
|---|---|---|---|
| **Human-verified** | `0` / `human-verified` | A World ID Proof of Human is bound to the reviewer's wallet, one review per person per agent. | Yes, weight 1.0 |
| **Paid-human** | `1` / `receipt-verified` | Everything above, **plus** a settled USDC payment to that agent from the reviewer (a single-use receipt). | Yes, weight 1.0 to 2.0 depending on the amount |
| **Wallet-verified** | `2` / `wallet-verified` | Only that a wallet signed this review. One person can control any number of wallets, so this says **nothing** about uniqueness. | **No. Never.** It is shown separately and informationally. |

Two points that are easy to get wrong:

- **Payment is not uniqueness.** A receipt proves an address paid. In Receipts a paid review still requires World ID; payment only adds weight.
- **"Human-verified" is a claim made by the Record Server.** The contract checks the server's signature. It cannot itself tell a World ID nullifier from any other 32-byte value (see the [threat model](docs/specs/THREAT_MODEL.md)). The reputation engine adds a defence in depth, but the trust in the server is real.

The UI labels these as "Human-verified", "Human-verified · Paid" and "Wallet-verified". The paid tag on-chain is `receipt-verified`; the UI says "Paid" because "receipt-verified" alone would suggest payment is the whole claim.

## Status: what is implemented, tested, and live

| Capability | Implemented in this repo | Tested locally | Live on Sepolia |
|---|---|---|---|
| Human-verified review (type 0) | Yes | Yes (contract and server tests) | Contracts deployed. **No review has been written on them yet** (see [below](#deployed-contracts-sepolia)). |
| Paid-human review (type 1): USDC settlement via `ReceiptSettler`, receipt consumed by the gateway | Yes in contracts and server | Yes | Contracts deployed. **No receipt has been settled yet.** There is **no paid-review flow in the web UI**. |
| Wallet-verified review (type 2): contract path | Yes (`submitWalletReview`) | Yes (`test/WalletReview.t.sol`) | **No.** The deployed gateway does not contain it. |
| Wallet-verified review: server and UI | Yes, behind `WALLET_REVIEWS_ENABLED` (default **off**) | Yes (automated tests only) | **No.** See the wallet note below. |
| Reputation engine and API (human, paid and wallet tiers; multi-gateway retrieval) | Yes | Yes (unit and mocked-chain tests) | **Yes.** Deployed and serving `receipts-reputation/1.1` with the three tiers; reads Sepolia live (see [deployed environment](#deployed-environment)). |
| Web app | Yes | Yes (24 tests, type-checked, builds) | **Yes**, behind a Cloudflare Quick Tunnel. Served bundle is byte-identical to a fresh build of `a96e4ed`. |
| **Live World ID Proof of Human verification** | Code written against the World ID 4.0 API | **Not tested against the live service** | **Not tested** |
| ENS integration | **Not implemented** | n/a | n/a |
| Arkiv public record (reviews + reputation snapshots on Rabdi; agent-page panel reads Arkiv directly) | Yes ([below](#arkiv)) | Yes (mocked writes; live read-only queries and gas estimates) | **Not yet.** No entity has been written; the first publication awaits approval |

### Wallet-verified reviews: signed, not submitted

With the flag on, the wallet flow ends at a **signed authorization**: the reviewer's wallet signs an EIP-712 message, and the Record Server returns an attestation for it. **Nothing is written on-chain**, because the deployed Sepolia gateway has no `submitWalletReview` function (a read-only call to `walletNullifier(address)` on the live gateway reverts, confirming the older bytecode). The UI says "It is not yet written on-chain". Putting wallet reviews on-chain would need a new gateway deployment and a `ReceiptSettler.setReviewGateway` call. **No deployment has been done or authorized.**

## Architecture

```
 Browser (React/Vite)                          Record Server (Hono, Node)
 ┌───────────────────┐   /api/world-id/request   ┌──────────────────────────┐
 │ review wizard     │ ─────────────────────────▶│ signs World ID rp_context│
 │ reputation views  │   /api/reviews/verify     │ verifies proof (World ID)│
 │ attack demo (sim) │ ─────────────────────────▶│ stores nullifier         │
 └───────┬───────────┘   /api/reviews/prepare    │ builds EIP-712 challenge │
         │ wallet signs  /api/reviews/attest     │ verifies wallet signature│
         │               ─────────────────────▶ │ signs gateway attestation│
         │               /api/agents/:id/reputation (weighted median)      │
         ▼                                        └───────────┬──────────────┘
 ReviewGateway ── giveFeedback ──▶ ERC-8004 Reputation Registry   │ reads logs
   │  ▲   consumes receipt            ▲                           ▼
   │  └── ReceiptSettler ◀── USDC (EIP-3009)       reputation engine (server/src/reputation)
   └── NullifierRegistry (one review per identity per agent)
```

- **Contracts** (`src/`): `ReviewGateway`, `ReceiptSettler`, `NullifierRegistry`, interfaces. Solidity 0.8.x, Foundry.
- **Record Server** (`server/`): TypeScript, Hono, viem. SQLite for development, PostgreSQL required in production.
- **Reputation** (`server/src/reputation/`): pure weighted-median engine, chain retrieval, evidence manifest.
- **Web** (`web/`): React, Vite, viem.
- **Infrastructure** (`infrastructure/`, `docker-compose*.yml`, `.github/`): Terraform, backup and deployment scripts, CI. **Not exercised by this documentation pass.**

Detailed write-ups are in [docs/specs/](docs/specs/): [architecture](docs/specs/ARCHITECTURE.md), [review types and labels](docs/specs/REVIEW_TYPES_AND_LABELS.md), [API](docs/specs/API.md), [reputation spec](docs/specs/REPUTATION_SPEC.md), [threat model](docs/specs/THREAT_MODEL.md), [decision records](docs/specs/DECISIONS.md).

## Deployed contracts (Sepolia)

Chain: Ethereum Sepolia, chain id `11155111`. The addresses come from `broadcast/Deploy.s.sol/11155111/run-latest.json` and the web and server config defaults. On 2026-11-06 they were checked **read-only** against a public Sepolia RPC (no transaction was sent):

| Contract | Address | Check |
|---|---|---|
| ReviewGateway | `0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD` | Has code. Points at the settler, nullifier registry and ERC-8004 registries below. `minPayment` is 1,000,000 (1 USDC). `recordServerSigner` is `0x203d0f8C67C66ebbbe1fe34A1E9f86aDc67da363`. Lacks `walletNullifier`. |
| ReceiptSettler | `0xC3AA7a2F43d83680f9E0B97e0Eb4fD01E421ceDe` | Has code. Its active `reviewGateway` is the gateway above. Its USDC is `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`. |
| NullifierRegistry | `0xBA688eDFd43719378b8D3dC333C858e8d5720a4C` | Has code. Referenced by the gateway. |
| ERC-8004 Identity Registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | Has code (a small proxy). Used by the gateway and the config. Whether it is the official ERC-8004 deployment is **not verified here**. |
| ERC-8004 Reputation Registry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | Same as above. |

Gateway deployment block: `12064002`.

**As of the same check there are no `ReviewSubmitted` events on the gateway and no `ReceiptSettled` events on the settler.** The contracts are deployed and wired together, but no review or payment has been recorded through them. A demo that shows an existing review list will show an empty one until a review is submitted.

Whether the source is verified on Etherscan was **not checked**.

## Deployed environment

The application is live at **https://campbell-stylus-berkeley-steal.trycloudflare.com**.

This is a **Cloudflare Quick Tunnel** pointed at a Docker Compose stack on the author's machine. It is a hackathon demo deployment, not production hosting. AWS deployment is written (`infrastructure/terraform/`) but **postponed**: the AWS account's services are not activated and an organization SCP denies ECR and Lambda, so nothing has been provisioned there.

```
Internet ──▶ Cloudflare Quick Tunnel ──▶ cloudflared ──▶ Caddy :80 ──┬──▶ /api/*, /reviews/*, /health ──▶ api :8080
             (ephemeral *.trycloudflare.com)                          └──▶ everything else ──▶ /srv (web/dist, SPA fallback)
                                                                                                    │
                                                                                      api ──▶ postgres:5432 (volume receipts_postgres-data)
                                                                                      api ──▶ Sepolia JSON-RPC (reads)
```

Everything is served from **one origin**. The frontend calls the API at a relative path (`VITE_API_BASE_URL` is empty), so there is no cross-origin request in normal use and no build-time coupling to the tunnel hostname in the bundle. The hostname appears only in the server's `CORS_ALLOWED_ORIGINS` and `REVIEW_CONTENT_BASE_URL`.

| Component | Value |
|---|---|
| API image | `local/receipts-api:integration-a96e4ed-20261106` |
| Previous image (rollback) | `local/receipts-api:dev` |
| Database | PostgreSQL 16.15, volume `receipts_postgres-data`, **schema v2** |
| Reverse proxy | `caddy:2.8-alpine`, config `infrastructure/caddy/Caddyfile` |
| Frontend | `web/dist`, bind-mounted read-only into Caddy at `/srv` |
| Chain | Ethereum Sepolia (`11155111`), read-only |
| `WALLET_REVIEWS_ENABLED` | **false** |

> **The tunnel hostname is ephemeral.** If `cloudflared` stops, Cloudflare issues a *different* hostname, and the running API keeps the old one in `CORS_ALLOWED_ORIGINS` and `REVIEW_CONTENT_BASE_URL`. Recovery requires updating `.env.prod` and recreating the API container. The procedure is in **[RUNBOOK_QUICK_TUNNEL.md](RUNBOOK_QUICK_TUNNEL.md)**.

### Running this stack yourself

Requires Docker, and a `.env.prod` built from [`.env.prod.example`](.env.prod.example) (it is gitignored and `chmod 600`; it holds the Record Server key, the World ID signing key, the RPC URL and the database password).

```bash
# 1. Build the API image. ECR_REGISTRY=local and IMAGE_TAG=<tag> in .env.prod
#    make compose use this local image instead of pulling.
docker build -t local/receipts-api:<tag> ./server

# 2. Build the frontend. Caddy serves web/dist directly, so this is live
#    the moment it finishes.
cd web && npm ci && npm run build && cd ..

# 3. Start the stack.
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d

# 4. Expose it. This prints the public hostname; put that hostname in
#    CORS_ALLOWED_ORIGINS and REVIEW_CONTENT_BASE_URL in .env.prod, then
#    recreate the API container so it picks them up.
cloudflared tunnel --url http://localhost:80 --no-autoupdate
```

To deploy a new API build without touching the database, the proxy or the tunnel:

```bash
docker build -t local/receipts-api:<new-tag> ./server
# set IMAGE_TAG=<new-tag> in .env.prod, then:
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --no-deps --pull never api
```

To roll back to the previous image (no database restore needed — see the paragraph below):

```bash
# set IMAGE_TAG=dev in .env.prod, then:
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --no-deps --pull never api
curl -sS https://campbell-stylus-berkeley-steal.trycloudflare.com/health
```

The schema is applied by the API at startup, inside a transaction under a PostgreSQL advisory lock. It is `CREATE TABLE IF NOT EXISTS` throughout and records the version it applied in `schema_version`, so starting a newer image against an older database upgrades it additively, and starting an **older** image against a newer database is a no-op rather than a downgrade. That is what makes an image rollback safe without a database restore.

## Quick start

See **[DEMO.md](DEMO.md)** for setup, environment variables, commands and a demo script. Short version:

```bash
# contracts
forge build && forge test --offline

# server (SQLite, development)
cd server && npm ci && cp .env.example .env   # fill in values, see DEMO.md
npm run dev

# web
cd web && npm ci && npm run dev               # http://localhost:5173
```

## Tests and results

Measured on the merged `integration` branch (commit `a96e4ed`) on 2026-11-06, and **re-run in full immediately before the deployment described above** with identical counts:

| Check | Result |
|---|---|
| Server: `npx vitest run` | 37 files, **1230 tests passed**, 0 failed |
| Server: `npx tsc --noEmit` | clean |
| Web: `npm test` | 4 files, **24 tests passed** |
| Web: `tsc --noEmit` and `npm run build` | clean; build succeeds (one chunk-size warning) |
| Contracts: `forge test --offline` | 14 suites, **279 passed, 0 failed, 9 skipped**. The 9 skipped are the fork tests, which need `RUN_FORK_TESTS=true` and an RPC. |

PostgreSQL-backed server tests run when a local `receipts_test` database is reachable and are skipped otherwise. In the runs recorded here the database was reachable. Passing tests are **not** evidence that live World ID verification or on-chain wallet submission works.

## Security and trust, in brief

Full version: [docs/specs/THREAT_MODEL.md](docs/specs/THREAT_MODEL.md). Highlights:

- **Not audited.** No external review of the contracts or the server has been done.
- **One trusted signer.** The gateway accepts any attestation signed by one key (`recordServerSigner`). If that key or the server logic is compromised, the "human-verified" label can be forged. The reputation engine rejects a human or paid review that carries a wallet-derived nullifier, which limits one specific forgery, not the general trust in the server.
- **Wallet-only reviews can be created in unlimited numbers by one person**, which is why they are excluded from the human score and shown as a separate informational count.
- **ERC-8004 registry pollution.** Wallet-verified feedback is written to the same registry under the same client address as human feedback. The registry's own mean includes it unless a consumer filters on `tag2`.
- **The score is a median of at least five distinct verified humans.** That is manipulation-resistant against an attacker below half the weight. It does not make the score true.

## Arkiv

Receipts publishes a public, queryable copy of its review record to [Arkiv](https://arkiv.network) (Rabdi testnet, chain `7794095`), so that other apps can read an agent's standing without our server or an archive node. PostgreSQL and the Sepolia contracts remain the source of truth.

- **Entities:** `receipts.review/v1`, one per confirmed on-chain review, and `receipts.reputation/v1`, one per agent snapshot. Full schema, owners and expiry: [arkiv/schema.md](arkiv/schema.md).
- **Writer:** `npm run arkiv:publish` in `server/` ([`server/src/arkiv/`](server/src/arkiv/)). It is a dry run unless given `--execute` with the hash of a reviewed plan file.
- **Reader:** the **Public record on Arkiv** card on each agent page ([`web/src/components/ArkivRecord.tsx`](web/src/components/ArkivRecord.tsx)), which queries Rabdi from the browser.
- **Private data stays off Arkiv:** no World ID nullifiers, signatures, authorizations or database state.

**Publisher wallet** (the only address that wrote these entities): `<ARKIV_PUBLISHER_ADDRESS — pending first publication>`. Explorer: `https://rabdi.explorer.arkiv.network/address/<ARKIV_PUBLISHER_ADDRESS>`.

**A query you can run** (no key, no Receipts server). It returns the latest reputation snapshot for agent 1:

```sh
curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'receipts.reputation/v1'"'"') AND agentId = str('"'"'1'"'"') AND $creator = addr(<ARKIV_PUBLISHER_ADDRESS>) ORDER BY snapshotBlock:u64 DESC",{"select":{"key":true,"owner":true,"expiresAt":true,"attributes":true},"limit":"0x1"}]}'
```

More queries, and why each field is indexed: [arkiv/how-you-use-arkiv.md](arkiv/how-you-use-arkiv.md). Why Arkiv rather than our database: [arkiv/why-arkiv.md](arkiv/why-arkiv.md). Feedback for the Arkiv team: [arkiv/friction.md](arkiv/friction.md).

**Built at ETHGlobal Mumbai.** Receipts itself is a from-scratch hackathon project, and the Arkiv integration was added during the same event: the `server/src/arkiv/` module and CLI, `test/arkiv.test.ts`, the web panel and `web/src/lib/arkiv.ts`, and the `arkiv/` documents.

## Not implemented

- **ENS** (reputation as ENS records) was considered and is **not implemented**. Nothing in this repository integrates with it.
- A paid-review flow in the web UI.
- On-chain submission of wallet-verified reviews on the deployed gateway.

## Known limitations

- Live World ID verification is untested; it needs a registered World ID relying party and real credentials, and the code carries the author's own "UNVERIFIED" notes in `server/.env.example`.
- No review exists on-chain yet (see above).
- The wallet flow marks a signing challenge spent when the attestation is issued. Because nothing can be submitted on-chain yet, a wallet that completes the flow is blocked from repeating it for that agent.
- The web app reads reviews from one gateway only, while the server's reputation endpoint can merge several. After any gateway replacement, the Reviews page would omit old-gateway reviews.
- `docker-compose.prod.yml` passes an explicit list of environment variables, and `WALLET_REVIEWS_ENABLED` and `ADDITIONAL_REVIEW_GATEWAYS` are not in it.
- The simulated "attack demo" page is a simulation served by the Record Server, not a live attack.
- The deployment runs on one machine behind an **ephemeral** Cloudflare Quick Tunnel. There is no redundancy, no uptime guarantee, and the public hostname changes if `cloudflared` restarts. See [RUNBOOK_QUICK_TUNNEL.md](RUNBOOK_QUICK_TUNNEL.md).
- Because `docker-compose.prod.yml` does not pass `WALLET_REVIEWS_ENABLED` through, the flag cannot be turned on from `.env.prod` alone. This currently fails safe — the server default is `false` — but it means the deployed stack has no supported way to enable wallet reviews, and the compose file would need an edit first.
- Database backups are manual (`pg_dump`). `infrastructure/backup/` contains scripts and systemd units for automated backups, but they are **not installed** on the machine running this deployment.
- AWS deployment is written but unprovisioned; see [deployed environment](#deployed-environment).

## AI use

AI tools were used to build this project. See **[AI_USAGE.md](AI_USAGE.md)** for exactly which, what is evidenced, and what the authors still need to fill in.

## Repository layout

```
src/            Solidity contracts          test/ script/   Foundry tests and scripts
server/         Record Server + reputation  web/            React app
broadcast/      Sepolia deployment records  infrastructure/ docker-compose*.yml .github/  deployment and CI
docs/specs/     Specifications and decision records
COORDINATION.md Integration coordination and audit log (on the feature/integration-qa branch)
```

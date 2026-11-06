# Receipts: demo and setup guide

Everything here was written from the source, the `.env.example` templates and the commands that were actually run. Anything that was **not** run is marked **UNTESTED**. Read [Known limitations](#known-limitations) before recording a demo.

## What can be demonstrated honestly

| Demo | Needs secrets? | State |
|---|---|---|
| Unit and contract test suites | No | Run and passing (see the README) |
| Read-only checks of the deployed Sepolia contracts | No | Run |
| Web app pages that read the chain (agents, docs) | No | App builds; browsing it against live Sepolia was **not** done in this pass |
| Simulated attack demo (`/demo`) and reputation tiers | A running Record Server | Server logic is tested; a browser walk-through was **not** done |
| Wallet-verified flow, local only, flag on | A running Record Server and a wallet | **UNTESTED end to end.** Automated tests only. Ends at a signed authorization, **not** an on-chain review |
| Human-verified review with live World ID | World ID credentials, the Record Server signer key, a funded Sepolia wallet | **UNTESTED.** Never run against the live service |
| Paid-human review | As above plus Sepolia USDC | **UNTESTED**, and there is no paid flow in the UI |

## Prerequisites

- Node.js and npm (the repository pins package versions in `package-lock.json`; the Node version is not pinned in the repo, so use a current LTS).
- [Foundry](https://book.getfoundry.sh/) (`forge`, `cast`).
- Git submodules for contracts: `git submodule update --init --recursive` (provides `lib/forge-std`).
- Optional: a local PostgreSQL if you want the PostgreSQL-backed server tests to run (see below).

## 1. Contracts

```bash
forge build
forge test --offline          # 279 passed, 9 skipped in the recorded run
```

The 9 skipped tests are fork tests. To run them you need a mainnet RPC (this was **not** done for this documentation):

```bash
RUN_FORK_TESTS=true MAINNET_RPC_URL=<your mainnet RPC> forge test
```

Do not run deployment scripts (`script/Deploy.s.sol`) as part of a demo. They broadcast transactions.

## 2. Server (Record Server)

```bash
cd server
npm ci
cp .env.example .env     # then fill it in (see the table below)
npm run dev              # tsx watch, loads .env, listens on PORT (default 3000)
npm test                 # vitest
npx tsc --noEmit
```

`npm run build` compiles to `dist/`; `npm start` runs it.

### Environment variables

Defaults and formats are in `server/.env.example` and `server/src/config/env.ts`. The server validates them at startup and **refuses to start** on a bad value.

| Variable | Required | Notes |
|---|---|---|
| `WORLD_APP_ID` | yes | `app_...`, from the World Developer Portal |
| `WORLD_RP_ID` | yes | `rp_...`. Nullifiers are scoped to it |
| `WORLD_SIGNING_KEY` | yes, **secret** | World ID RP signing key. Must match the key registered for the RP |
| `WORLD_ENVIRONMENT` | no | `production` (default), `staging` or `sandbox`. Proofs from another environment are rejected |
| `RECORD_SERVER_PRIVATE_KEY` | yes, **secret** | Its address must equal the gateway's `recordServerSigner`. The server checks this against the chain at startup |
| `REVIEW_GATEWAY_ADDRESS` | yes | Becomes the EIP-712 `verifyingContract` |
| `CHAIN_ID` | no | Default `11155111` |
| `RPC_URL` | yes | Sepolia JSON-RPC. Treat as secret if it carries an API key |
| `REVIEW_CONTENT_BASE_URL` | yes | Public origin the server is reachable at. Part of every signed `feedbackURI` |
| `PORT`, `NODE_ENV` | no | `3000`, `development` |
| `DATABASE_DRIVER` | no | `sqlite` (default) or `postgres`. **Production refuses to boot on anything but `postgres`** |
| `DATABASE_PATH` | no | SQLite file, default `./data/receipts.db` |
| `DATABASE_URL` | with `postgres` | Secret |
| `RECEIPT_SETTLER_ADDRESS`, `IDENTITY_REGISTRY_ADDRESS`, `REPUTATION_REGISTRY_ADDRESS` | no, but needed together | Supplying all three mounts `GET /api/agents/:id/reputation`. The values in `.env.example` match the deployed addresses in the README |
| `GATEWAY_DEPLOY_BLOCK` | no | `12064002` for the deployed gateway. Log scans start here |
| `REPUTATION_CONFIRMATIONS` | no | Blocks to stay behind the head when scoring |
| `CORS_ALLOWED_ORIGINS` | prod only | Explicit origins; `*` is rejected |
| `TRUST_PROXY` | no | Whether to trust forwarded client IPs for rate limiting |
| `WALLET_REVIEWS_ENABLED` | no | **Default `false`. Keep it `false` unless you are deliberately demoing the local wallet flow.** Any value other than `true` or `false` fails startup |
| `ADDITIONAL_REVIEW_GATEWAYS` | no | `address@deployBlock,address@deployBlock`. Older gateways whose reviews still count in reputation. Not needed until a gateway is replaced |

Neither `WALLET_REVIEWS_ENABLED` nor `ADDITIONAL_REVIEW_GATEWAYS` appears in `server/.env.example` or `docker-compose.prod.yml` yet. Set them in `server/.env` for local runs.

**Important:** the server will not start against the deployed gateway unless `RECORD_SERVER_PRIVATE_KEY` is the key for `recordServerSigner` (`0x203d0f8C67C66ebbbe1fe34A1E9f86aDc67da363`). Only the project owner has it. Without it you can run the tests and the web app's read-only pages, but not the live Record Server.

### Database

SQLite is used by default in development. Migrations `001` to `006` apply on boot.

PostgreSQL-backed tests run automatically when a database at `postgres://$USER@localhost:5432/receipts_test` is reachable, or at `TEST_DATABASE_URL`, and are skipped otherwise.

## 3. Web app

```bash
cd web
npm ci
cp .env.example .env     # optional; defaults point at the deployed Sepolia contracts
npm run dev              # http://localhost:5173, proxies /api, /reviews, /health to the server
npm test
npm run build            # tsc --noEmit && vite build
```

The dev server proxies to `http://localhost:3000` by default. Set `RECORD_SERVER_URL` in `web/.env` to change that. Every `VITE_`-prefixed variable is public and ends up in the bundle; never put secrets in them. The variables and their defaults are in `web/.env.example`.

## 4. Read-only on-chain checks

These send no transactions:

```bash
RPC=https://ethereum-sepolia-rpc.publicnode.com
G=0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD
cast chain-id --rpc-url $RPC                                        # 11155111
cast call $G 'recordServerSigner()(address)' --rpc-url $RPC
cast call $G 'receiptSettler()(address)'     --rpc-url $RPC
cast call $G 'nullifierRegistry()(address)'  --rpc-url $RPC
# Expected to REVERT: the deployed gateway has no wallet-review support.
cast call $G 'walletNullifier(address)(bytes32)' 0x1111111111111111111111111111111111111111 --rpc-url $RPC
```

## 5. Demo script

Suggested order, using only what is real:

1. **The problem.** Explain that the ERC-8004 registry's own summary is a mean that fresh addresses can move. Point at the AttackLab test and script, and say clearly that the fork experiment is skipped by default and was not re-run for this documentation. The web `/demo` page is a **simulation** and is labelled that way.
2. **The design.** Walk through the three review types in the README. Stress that wallet-verified reviews are **excluded** from the human score and that payment is not uniqueness.
3. **Reputation tiers.** On an agent page, show the separate human, paid-human and wallet panels. Only the server running with the reputation env set provides them. An agent with fewer than five distinct verified humans shows no score.
4. **Tests.** Show the server, web and Forge results.
5. **Wallet flow (optional, local only, flag on).** Show that it ends at "Wallet authorisation signed ... not yet written on-chain". Do not describe it as a published review.
6. **Live human-verified review (only if the owner has rehearsed it).** This needs a registered World ID relying party, the Record Server signer key, a Sepolia wallet with ETH for gas, a wallet that does not own the reviewed agent, and World App with a Proof of Human credential. **None of this was exercised in this documentation pass.** If it has not been rehearsed, leave it out and say so.

Do not claim ENS integration; it is not implemented. For Arkiv, claim only what has been published: until the first approved `npm run arkiv:publish -- --execute` the agent page's Arkiv card shows no records, and the README's publisher address is a placeholder. The Arkiv demo sequence is in [arkiv/DEMO.md](arkiv/DEMO.md).

## Known limitations

- **Live World ID verification: untested.** The code targets the World ID 4.0 API. `server/.env.example` itself lists unverified behaviours (many dynamic per-agent actions, environment scoping).
- **No review and no payment has been recorded on the deployed contracts** at the time of the last check (zero `ReviewSubmitted` and zero `ReceiptSettled` events).
- **Wallet-verified reviews are not on-chain.** The deployed gateway lacks `submitWalletReview`. The wallet flow ends at a signed authorization. A gateway redeployment would be needed, and has **not** been done or authorized.
- **Wallet flow lockout.** Completing it consumes the signing challenge, so that wallet cannot repeat it for that agent, even though nothing was written on-chain.
- **No paid-review flow in the UI.** The contracts and server support paid reviews; the web app does not offer one.
- **Reviews page reads one gateway.** After a gateway replacement it would omit older reviews, while the server's reputation endpoint (with `ADDITIONAL_REVIEW_GATEWAYS`) would keep them.
- **Fork tests skipped by default**, so the AttackLab numbers (mean 50 to 77) are documented in the test, not re-verified here.
- **Infrastructure untested here.** `infrastructure/`, `docker-compose*.yml` and `.github/` workflows were not run for this documentation.
- **Not audited.** See `docs/specs/THREAT_MODEL.md`.

# Receipts

**Reviews for AI agents that bots cannot outvote.**

ERC-8004 gives every AI agent an on-chain reputation, but anyone can write to it and its score is a plain average. Receipts gates the write path — a review only counts if a **verified human** wrote it, optionally **bound to a real USDC payment** to that agent — and replaces the average with a **weighted median** that an attacker holding less than half the weight mathematically cannot move past honest opinion.

Built from scratch at **ETHGlobal Mumbai 2026**. Live on Ethereum Sepolia.

> **Live demo:** the URL is in the ETHGlobal submission (the app runs behind a Cloudflare Quick Tunnel whose hostname rotates; see [RUNBOOK_QUICK_TUNNEL.md](RUNBOOK_QUICK_TUNNEL.md)).
> **Demo video:** linked in the ETHGlobal submission. Walkthrough script: [DEMO.md](DEMO.md).

---

## The problem, demonstrated — not asserted

The ERC-8004 Reputation Registry accepts feedback from any address and summarizes it as an arithmetic mean. This repo attacks that design twice:

**1. On a mainnet fork** ([`test/AttackLab.t.sol`](test/AttackLab.t.sol)): six freshly created wallets drag a live agent's registry score from **50 to 77**. Cost: gas.

**2. Across 10,000 randomized attack scenarios** (the *gauntlet*, runnable in the app and via `POST /api/reputation/simulate/gauntlet`): random honest crowds (3–20 humans rating 40–60) versus attacker gangs (1–25 wallets, all rating 100 or all 0). Every trial is scored twice over identical reviews — once with the registry's mean, once with the Receipts weighted median. Deterministic seed `8004`; anyone re-running gets these exact numbers:

| | Registry mean | Receipts weighted median |
|---|---|---|
| Score pushed past *every* honest rating | 9,126 / 10,000 | 5,654 / 10,000 |
| …in the 4,185 trials where attackers held **under half the weight** | **3,311** | **0** |

That zero is the median's breakdown-point guarantee, not luck: a minority of the weight can shift a median *between* honest opinions, but can never push it *beyond* what some honest reviewer actually said. A majority defeats any aggregation rule — which is exactly why Receipts makes majorities expensive: each vote costs one **human**, not one address.

## How it works

Three rules, enforced in order:

1. **Only verified writes.** A `ReviewGateway` contract is the sole writer of Receipts feedback into the ERC-8004 registry. It only accepts a review carrying an EIP-712 attestation signed by the Record Server, which has verified the reviewer first.
2. **One review per human per agent.** Personhood comes from **World ID 4.0** (Proof of Human); the proof's nullifier is consumed on-chain in a `NullifierRegistry`, so the same person cannot review the same agent twice — from any number of wallets.
3. **Payment adds weight, never identity.** A reviewer who actually paid the agent — USDC via EIP-3009 `receiveWithAuthorization` through the `ReceiptSettler`, with a nonce that cryptographically binds agent, order and chain — gets up to 2× weight. A receipt proves payment, not uniqueness: a paid review still requires World ID.

Scores are a weighted median over verified humans, published only once **five distinct humans** have reviewed.

```
 Browser (React/Vite)                          Record Server (Hono, TypeScript)
 ┌───────────────────┐   /api/world-id/request   ┌──────────────────────────┐
 │ review wizard     │ ─────────────────────────▶│ signs World ID rp_context│
 │ reputation views  │   /api/reviews/verify     │ verifies Proof of Human  │
 │ attack gauntlet   │ ─────────────────────────▶│ stores nullifier (unique │
 └───────┬───────────┘   /api/reviews/prepare    │  per human per agent)    │
         │ wallet signs  /api/reviews/attest     │ builds EIP-712 challenge │
         │               ─────────────────────▶  │ signs gateway attestation│
         │               /api/agents/:id/reputation (weighted median)      │
         ▼                                        └───────────┬─────────────┘
 ReviewGateway ── giveFeedback ──▶ ERC-8004 Reputation Registry │ reads logs
   │  ▲   consumes receipt            ▲                         ▼
   │  └── ReceiptSettler ◀── USDC (EIP-3009)      reputation engine (server/src/reputation)
   └── NullifierRegistry (one review per human per agent)
```

### Review types, labelled honestly

| Type | `reviewType` / tag | Proves | Counts toward the score? |
|---|---|---|---|
| **Human-verified** | `0` / `human-verified` | World ID Proof of Human bound to the reviewer's wallet | Yes, weight 1.0 |
| **Paid-human** | `1` / `receipt-verified` | All of the above **plus** a settled USDC payment to that agent (single-use receipt) | Yes, weight 1.0–2.0 by amount |
| **Wallet-verified** | `2` / `wallet-verified` | Only that *a wallet* signed. One person can control any number of wallets | **Never.** Shown separately, informationally |

Two distinctions this project refuses to blur: **payment is not uniqueness** (a receipt proves an address paid; only World ID proves a person), and **"human-verified" is a claim made by the Record Server** — the contract checks the server's signature, and that trust is documented, not hidden ([threat model](docs/specs/THREAT_MODEL.md)).

## What is live right now

- **Contracts deployed and wired on Sepolia** (table below), with **real reviews on-chain**: the full pipeline — live World ID 4.0 verification (staging environment) → EIP-712 wallet signature → Record Server attestation → `giveFeedback` on the registry — has been exercised end-to-end, and the reputation engine reads those reviews back from Sepolia logs. Agents below the five-human floor correctly show *below threshold* instead of a score.
- **The web app** (review wizard, per-agent reputation with evidence, live attack gauntlet) serving against those contracts.
- **The reputation API** serving `receipts-reputation/1.1` with per-tier breakdowns and a reproducible evidence manifest per score.

### Deployed contracts (Sepolia, chain `11155111`)

| Contract | Address |
|---|---|
| ReviewGateway | [`0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD`](https://sepolia.etherscan.io/address/0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD) |
| ReceiptSettler | [`0xC3AA7a2F43d83680f9E0B97e0Eb4fD01E421ceDe`](https://sepolia.etherscan.io/address/0xC3AA7a2F43d83680f9E0B97e0Eb4fD01E421ceDe) |
| NullifierRegistry | [`0xBA688eDFd43719378b8D3dC333C858e8d5720a4C`](https://sepolia.etherscan.io/address/0xBA688eDFd43719378b8D3dC333C858e8d5720a4C) |
| ERC-8004 Identity Registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation Registry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

Deployment record: [`broadcast/Deploy.s.sol/11155111/`](broadcast/Deploy.s.sol/11155111/). USDC is the canonical Sepolia FiatTokenV2.2 (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`), full EIP-3009.

## Partner integrations

### World ID (IDKit 4.0)

Personhood is the load-bearing wall, and the integration is current-generation World ID 4.0, not legacy:

- The Record Server **signs `rp_context` server-side** per request — the browser relays it to IDKit and never decides it ([`server/src/worldid/`](server/src/worldid/)).
- Credential preset **`proofOfHuman`**, with **per-agent actions** so each agent gets its own nullifier namespace: one proof, one review, per human, per agent.
- Nullifier uniqueness is enforced twice: `UNIQUE(nullifier, action)` in the server database, and on-chain in `NullifierRegistry` where the gateway consumes it.
- The reputation engine rejects any human-labelled review whose nullifier matches a wallet derivation — defence in depth against one specific server-forgery class.

### Arkiv

Receipts publishes its public record to [Arkiv](https://arkiv.network) (Rabdi testnet, chain `7794095`), so anyone can read an agent's standing **without our server or an archive node**:

- **Entities:** `receipts.review/v1` (one per confirmed on-chain review) and `receipts.reputation/v1` (one per agent snapshot). Schema, ownership and expiry: [arkiv/schema.md](arkiv/schema.md).
- **Writer:** `npm run arkiv:publish` ([`server/src/arkiv/`](server/src/arkiv/)) — dry-run by default, executes only against the hash of a reviewed plan file. No World ID nullifiers, signatures or private state ever leave for Arkiv.
- **Reader:** the *Public record on Arkiv* panel on each agent page queries Rabdi **directly from the browser** ([`web/src/components/ArkivRecord.tsx`](web/src/components/ArkivRecord.tsx)).
- Queries filter by `$owner`/creator because anyone can write under a schema tag — details and rationale: [arkiv/how-you-use-arkiv.md](arkiv/how-you-use-arkiv.md), [arkiv/why-arkiv.md](arkiv/why-arkiv.md), feedback for the Arkiv team: [arkiv/friction.md](arkiv/friction.md).

The first mainnet-visible publication awaits a funded publisher key; the module, tests, CLI and reader shipped during the event.

## Run it yourself

```bash
# contracts
forge build && forge test --offline

# server (SQLite in development; PostgreSQL in production)
cd server && npm ci && cp .env.example .env   # fill in values — see DEMO.md
npm run dev

# web
cd web && npm ci && npm run dev               # http://localhost:5173
```

Full setup, environment variables, the Docker Compose production stack and the demo script: **[DEMO.md](DEMO.md)** and [docs/deployment/](docs/deployment/). The gauntlet needs only the server: `curl -X POST localhost:8080/api/reputation/simulate/gauntlet`.

## Tests

| Suite | Result |
|---|---|
| Server (`npx vitest run`) | 39 files, **1,274 passed**, 0 failed |
| Contracts (`forge test --offline`) | 14 suites, **279 passed**, 0 failed, 9 skipped (the fork tests, which need `RUN_FORK_TESTS=true` + an RPC) |
| Web (`npm test`) | 5 files, **27 passed** |
| Types | `tsc --noEmit` clean on server and web; `npm run build` clean |

Property tests pin the median's manipulation bound; integrity tests recompute evidence manifests; concurrency tests race nullifier consumption on PostgreSQL.

## Security and honesty, in brief

Full version: [docs/specs/THREAT_MODEL.md](docs/specs/THREAT_MODEL.md).

- **Not audited.** Hackathon code.
- **One trusted signer.** The gateway trusts attestations from one Record Server key. If that key is compromised, the human-verified label can be forged; the engine's nullifier checks narrow, but do not remove, that trust.
- **Wallet-only reviews are sybil-able by construction** — which is exactly why they never touch the human score.
- **The median resists manipulation; it does not make reviews true.** It bounds what a minority can do, nothing more.

Not implemented: ENS integration (considered, dropped); a paid-review flow in the web UI (contracts and server support it; the UI does not yet); on-chain submission of wallet-verified reviews on the deployed gateway (the flow ends at a signed attestation). More in [docs/specs/DECISIONS.md](docs/specs/DECISIONS.md).

## How it was built

From scratch during ETHGlobal Mumbai 2026 (Nov 5–7). AI tools were used throughout and are disclosed in **[AI_USAGE.md](AI_USAGE.md)**; the specifications and decision records the work was driven from are committed under [docs/specs/](docs/specs/).

## Repository layout

```
src/ test/ script/   Solidity contracts, Foundry tests, deploy + attack-lab scripts
server/              Record Server (Hono): World ID, signing, reputation engine, Arkiv module
web/                 React app: review wizard, reputation views, attack gauntlet
broadcast/           Sepolia deployment records
infrastructure/      Caddy, Docker Compose, Terraform, backups, CI
docs/specs/          Architecture, API, reputation spec, threat model, decision records
arkiv/               Arkiv schema and integration notes
```

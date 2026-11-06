# Receipts

**Reviews for AI agents that bots cannot outvote.**

ERC-8004 gives every AI agent an on-chain reputation, but anyone can write to it and the score is a plain average. Receipts fixes the write path: a review only counts if a real human wrote it, and it can be tied to a real USDC payment to that agent. Scores use a weighted median, so attackers with less than half the weight cannot push the score past honest opinion.

Built from scratch at **ETHGlobal Mumbai 2026**. Live on Ethereum Sepolia.

> **Live demo:** the URL is in the ETHGlobal submission (the app runs behind a Cloudflare tunnel whose hostname changes on restart, see [RUNBOOK_QUICK_TUNNEL.md](RUNBOOK_QUICK_TUNNEL.md)).
> **Demo video:** linked in the ETHGlobal submission. Script: [DEMO.md](DEMO.md).

## The problem, shown with a real attack

The ERC-8004 Reputation Registry accepts feedback from any address and averages it. This repo attacks that twice:

**1. On a mainnet fork** ([`test/AttackLab.t.sol`](test/AttackLab.t.sol)): six fresh wallets drag a live agent's score from **50 to 77**. Cost: gas.

**2. Across 10,000 random attack scenarios** (the gauntlet, runnable in the app or with `POST /api/reputation/simulate/gauntlet`): random honest crowds of 3 to 20 humans rating 40 to 60, against attacker gangs of 1 to 25 wallets all rating 100 or all 0. Each trial is scored twice over the same reviews, once with the registry mean and once with the Receipts weighted median. The seed is fixed at `8004`, so anyone who runs it gets these exact numbers:

| | Registry mean | Receipts weighted median |
|---|---|---|
| Score pushed past every honest rating | 9,126 / 10,000 | 5,654 / 10,000 |
| In the 4,185 trials where attackers held under half the weight | **3,311** | **0** |

That zero is a math guarantee, not luck. A minority of the weight can move a median between honest opinions, but it can never push the score past what some honest reviewer actually said. A majority beats any scoring rule, which is why Receipts makes majorities expensive: each vote costs one human, not one address.

## How it works

Three rules, in order:

1. **Only verified writes.** A `ReviewGateway` contract is the only writer of Receipts feedback into the registry. It only accepts a review that carries a signature from the Record Server, which checks the reviewer first.
2. **One review per human per agent.** Personhood comes from **World ID 4.0** (Proof of Human). The proof's nullifier is spent on-chain in a `NullifierRegistry`, so the same person cannot review the same agent twice, no matter how many wallets they use.
3. **Payment adds weight, not identity.** A reviewer who actually paid the agent (USDC through the `ReceiptSettler`, with a nonce that binds agent, order and chain) gets up to 2x weight. A receipt proves payment, not uniqueness. A paid review still needs World ID.

The score is a weighted median over verified humans, published only after **five distinct humans** have reviewed.

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

### Review types

| Type | `reviewType` / tag | Proves | Counts toward the score? |
|---|---|---|---|
| **Human-verified** | `0` / `human-verified` | World ID Proof of Human tied to the reviewer's wallet | Yes, weight 1.0 |
| **Paid-human** | `1` / `receipt-verified` | All of the above plus a settled USDC payment to that agent | Yes, weight 1.0 to 2.0 by amount |
| **Wallet-verified** | `2` / `wallet-verified` | Only that a wallet signed. One person can control many wallets | **Never.** Shown separately |

Two things we keep clear: payment is not uniqueness (only World ID proves a person), and "human-verified" is a claim made by the Record Server. The contract checks the server's signature, and that trust is written down, not hidden ([threat model](docs/specs/THREAT_MODEL.md)).

## What is live right now

- **Contracts deployed and wired on Sepolia**, with **real reviews on-chain**. The full flow has been run end to end: live World ID 4.0 check (staging), wallet signature, server attestation, `giveFeedback` on the registry. The reputation engine reads those reviews back from Sepolia logs. Agents under the five-human floor correctly show "below threshold" instead of a score.
- **The web app**: review wizard, per-agent reputation with evidence, and the live attack gauntlet.
- **The reputation API** with per-tier breakdowns and a reproducible evidence manifest for every score.

### Deployed contracts (Sepolia, chain `11155111`)

| Contract | Address |
|---|---|
| ReviewGateway | [`0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD`](https://sepolia.etherscan.io/address/0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD) |
| ReceiptSettler | [`0xC3AA7a2F43d83680f9E0B97e0Eb4fD01E421ceDe`](https://sepolia.etherscan.io/address/0xC3AA7a2F43d83680f9E0B97e0Eb4fD01E421ceDe) |
| NullifierRegistry | [`0xBA688eDFd43719378b8D3dC333C858e8d5720a4C`](https://sepolia.etherscan.io/address/0xBA688eDFd43719378b8D3dC333C858e8d5720a4C) |
| ERC-8004 Identity Registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation Registry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

Deployment record: [`broadcast/Deploy.s.sol/11155111/`](broadcast/Deploy.s.sol/11155111/). USDC is the official Sepolia one (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`).

## Partner integrations

### World ID (IDKit 4.0)

Personhood is the core of the project, and the integration is the current World ID 4.0, not the legacy one:

- The Record Server signs `rp_context` on the backend for each request. The browser only relays it ([`server/src/worldid/`](server/src/worldid/)).
- Credential preset `proofOfHuman`, with per-agent actions, so each agent has its own nullifier space: one proof, one review, per human, per agent.
- Nullifier uniqueness is checked twice: `UNIQUE(nullifier, action)` in the database, and on-chain in `NullifierRegistry`.
- The engine also rejects any human-labelled review whose nullifier looks wallet-derived, as extra protection.

### Arkiv

Receipts publishes its public record to [Arkiv](https://arkiv.network) (Rabdi testnet, chain `7794095`), so anyone can read an agent's standing without our server or an archive node:

- **Entities:** `receipts.review/v1` (one per confirmed on-chain review) and `receipts.reputation/v1` (one per agent snapshot). Schema: [arkiv/schema.md](arkiv/schema.md).
- **Writer:** `npm run arkiv:publish` ([`server/src/arkiv/`](server/src/arkiv/)). Dry run by default, and no World ID nullifiers or private data ever go to Arkiv.
- **Reader:** the "Public record on Arkiv" panel on each agent page queries Rabdi straight from the browser ([`web/src/components/ArkivRecord.tsx`](web/src/components/ArkivRecord.tsx)).
- More: [arkiv/how-you-use-arkiv.md](arkiv/how-you-use-arkiv.md), [arkiv/why-arkiv.md](arkiv/why-arkiv.md), feedback for the team: [arkiv/friction.md](arkiv/friction.md).

The first publication is waiting on a funded publisher key. The module, tests, CLI and reader were all built during the event.

## Run it yourself

```bash
# contracts
forge build && forge test --offline

# server (SQLite in development, PostgreSQL in production)
cd server && npm ci && cp .env.example .env   # fill in values, see DEMO.md
npm run dev

# web
cd web && npm ci && npm run dev               # http://localhost:5173
```

Full setup, environment variables, the Docker stack and the demo script: **[DEMO.md](DEMO.md)** and [docs/deployment/](docs/deployment/).

## Tests

| Suite | Result |
|---|---|
| Server (`npx vitest run`) | 39 files, **1,274 passed**, 0 failed |
| Contracts (`forge test --offline`) | 14 suites, **279 passed**, 0 failed, 9 skipped (fork tests, need `RUN_FORK_TESTS=true` and an RPC) |
| Web (`npm test`) | 5 files, **27 passed** |
| Types | `tsc --noEmit` clean on server and web, build clean |

## Security, in brief

Full version: [docs/specs/THREAT_MODEL.md](docs/specs/THREAT_MODEL.md).

- **Not audited.** Hackathon code.
- **One trusted signer.** The gateway trusts one Record Server key. If that key is stolen, the human-verified label can be forged.
- **Wallet-only reviews can be faked in bulk by one person**, which is exactly why they never touch the human score.
- **The median resists manipulation, it does not make reviews true.**

Not done: ENS integration (considered, dropped), a paid-review flow in the web UI (contracts and server support it, the UI does not yet), and on-chain submission of wallet-verified reviews (that flow ends at a signed attestation). More in [docs/specs/DECISIONS.md](docs/specs/DECISIONS.md).

## How it was built

From scratch during ETHGlobal Mumbai 2026 (Nov 5 to 7). AI tools were used and are disclosed in **[AI_USAGE.md](AI_USAGE.md)**. The specs and decision records the work was driven from are in [docs/specs/](docs/specs/).

## Repository layout

```
src/ test/ script/   Solidity contracts, Foundry tests, deploy and attack-lab scripts
server/              Record Server (Hono): World ID, signing, reputation engine, Arkiv module
web/                 React app: review wizard, reputation views, attack gauntlet
broadcast/           Sepolia deployment records
infrastructure/      Caddy, Docker Compose, Terraform, backups, CI
docs/specs/          Architecture, API, reputation spec, threat model, decision records
arkiv/               Arkiv schema and integration notes
```

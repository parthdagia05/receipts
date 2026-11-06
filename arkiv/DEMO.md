# Arkiv demo

Two networks are involved. Keep them apart when presenting:

| | Sepolia | Rabdi |
|---|---|---|
| What it is | Ethereum testnet, chain `11155111` | Arkiv testnet, chain `7794095` |
| What lives there | ERC-8004 registries, ReviewGateway, the reviews themselves | Receipts' public copy: review entities and reputation snapshots |
| Explorer | [sepolia.etherscan.io](https://sepolia.etherscan.io) | [rabdi.explorer.arkiv.network](https://rabdi.explorer.arkiv.network) |
| Source of truth? | Yes | No. A readable mirror, checked against Sepolia |

Steps marked **(write)** send an Arkiv transaction and need the publisher key. Every other step only reads.

## What is published now

- **Transaction:** [`0x1d265ea2…fc64`](https://rabdi.explorer.arkiv.network/tx/0x1d265ea22b66b40d9261ecf6e9a55e02f2266d022e2c62b9d911af5f7791fc64) on Rabdi block 309,831. One transaction, 4 entities. Gas used 1,951,960, cost 0.00195 tGLM.
- **Publisher:** [`0x98A4e58bB26ced2656e260DDb62C915465ce4b3e`](https://rabdi.explorer.arkiv.network/address/0x98A4e58bB26ced2656e260DDb62C915465ce4b3e), owner and creator of all four. A dedicated key, separate from the attestation signer. Balance after publishing: 0.048 tGLM.
- **Hash check:** both review entities store their text. keccak256 of the stored bytes equals the `feedbackHash` in the review's Sepolia event, checked after publishing and again in the browser on every page load.
- **Test data, not real people.** Both reviews were verified with **staging World ID, which only accepts the World ID Simulator**. They are not production or Orb verifications. Each review entity records `worldIdEnvironment = staging` and RP `rp_c357f900d4501523`, and the app labels them **Staging World ID · Simulator test**.
- **Below threshold.** Each agent has 1 verified human of the 5 needed, so neither snapshot carries a score.

| Entity | Agent | Key | What it holds | Expires |
|---|---|---|---|---|
| `receipts.review/v1` | 11294 | [`0x3c526a6e…e66d`](https://rabdi.explorer.arkiv.network/entity/0x3c526a6e261f77bb1e217577e6b57cd302da1bf5bc14da0436ec36b6130ce66d) | rating 100, 46-byte text, Sepolia tx [`0xcd30…7e83`](https://sepolia.etherscan.io/tx/0xcd301a8f037b21be67e050f4292da43fb24da418200b99e6a5a05c33e5b67e83) | about 182 days (block 8,193,831) |
| `receipts.review/v1` | 11292 | [`0xf8a079e6…35a5`](https://rabdi.explorer.arkiv.network/entity/0xf8a079e6cf1716d20105f6a5468fb22b44aef0ac0f0e9258c90d05965add35a5) | rating 47, 56-byte text, Sepolia tx [`0x7f2e…cc9a`](https://sepolia.etherscan.io/tx/0x7f2e732549d0fc8a4cf2f70fcb2a404395c1c48cde8f3f3a0c8c91bfd6b2cc9a) | about 182 days (block 8,193,831) |
| `receipts.reputation/v1` | 11292 | [`0xee0e7125…6343`](https://rabdi.explorer.arkiv.network/entity/0xee0e7125f63ebe47a70c6492459558f82c0b1e88b3073cbb248b9c00247a6343) | `below_threshold`, 1 of 5 humans, 0 production / 1 staging / 0 unknown | 7 days (block 612,231) |
| `receipts.reputation/v1` | 11294 | [`0x3a813d5c…bfa3`](https://rabdi.explorer.arkiv.network/entity/0x3a813d5c778b5f52ca32db496600228f9b777b8a12c5e38a7dedec6ee6d7bfa3) | `below_threshold`, 1 of 5 humans, 0 production / 1 staging / 0 unknown | 7 days (block 612,231) |

## Setup (once)

1. **Publisher wallet.** A key used only for Arkiv: `0x98A4e58bB26ced2656e260DDb62C915465ce4b3e`. It is not the Record Server key; the CLI checks the gateway's `recordServerSigner` and refuses if they match. The private key lives outside the repo in a mode 600 file and is passed to the CLI through the environment.
2. **Fund it** from the [Rabdi faucet](https://hub.arkiv.network/faucet). The first publication (2 reviews, 2 snapshots) used 1,951,960 gas, 0.00195 tGLM at 1 gwei.
3. **Configure.**
   - Server side: `ARKIV_PUBLISHER_PRIVATE_KEY`, plus the chain settings the API uses. `RPC_URL` must be an archive-capable Sepolia endpoint.
   - `ARKIV_CONTENT_BASE_URL=https://receipts-8004.pages.dev`. Review text is fetched from there, not from the `feedbackURI` on-chain, because older reviews point at `localhost`.
   - `ARKIV_PROVENANCE_DATABASE_URLS`: the Postgres databases that hold World ID verification records, opened read-only. `ARKIV_RP_ENVIRONMENTS=rp_d3afb91156ea1942:production,rp_c357f900d4501523:staging`.
   - Web build: `VITE_ARKIV_PUBLISHER_ADDRESS=0x98A4e58bB26ced2656e260DDb62C915465ce4b3e`. Locally it is in `web/.env.local`. The Pages deploy builds from a clean clone, so pass it on the build command there.
4. **Dry run** (read-only):
   ```sh
   cd server && npm run arkiv:publish
   ```
   It prints every entity value, the publisher and its balance, a gas estimate and a `planHash`, and writes `arkiv-plan.json`. `refused` must be empty.
5. **(write) Publish exactly that plan:**
   ```sh
   npm run arkiv:publish -- --execute --plan arkiv-plan.json --confirm <planHash>
   ```
   It refuses if the file changed, if the key is for a different publisher, or if any planned review is already on Arkiv.

## How review text stays honest

- The gateway signs `feedbackHash`, the keccak256 of the review text, into the Sepolia event.
- The publisher fetches the text from `https://receipts-8004.pages.dev/reviews/<feedbackHash>` and hashes it. Bytes that do not hash to the on-chain value are dropped; the entity is published without text rather than with the wrong text.
- The entity stores the bytes themselves. So the Arkiv copy does not depend on our server, or on the `localhost` URIs some early reviews carry. Nothing on Sepolia is changed.
- The browser hashes the bytes again when it shows them. That is the **Text matches on-chain hash** badge.

## Say this plainly

The reviews published so far were verified with **staging World ID, which only accepts the World ID Simulator**. They are test reviews. They prove the pipeline (Sepolia, hash check, Arkiv, browser check), not that real people reviewed these agents. The app shows a **Staging World ID · Simulator test** badge on each one and a **Test data** warning on the card. Do not describe them as Orb or production verifications.

## On camera (about 2 minutes)

1. **A review on Sepolia.** Open agent 11292 at `https://receipts-8004.pages.dev/agents/11292`. Its review list comes from the gateway's `ReviewSubmitted` events. Click **Sepolia tx**.
2. **Its Arkiv entity.** On the same page, the **Public record on Arkiv** card reads Rabdi straight from the browser. Point at:
   - **Connected**, with the Rabdi block it answered at, and the publisher it trusts;
   - the review entity: rating, reviewer, feedback hash, feedback index, Sepolia block, entity key and expiry;
   - **Matches Sepolia**: the entity agrees with the on-chain review in the same transaction;
   - **Staging World ID · Simulator test**, and the RP id it was verified through.
3. **The stored text and hash check.** The review text shown comes out of the entity. **Text matches on-chain hash** is computed in the browser. **Public text** opens the same bytes from Receipts.
4. **The reputation snapshot.** Score, status, verified humans and how many of them were production, staging or unknown, Sepolia block, evidence hash, and its 7-day expiry. **Versus API now** compares it with what the live API computes.
5. **The explorer.** Click **Arkiv entity**, then the publisher address. Every entity lists the publisher as owner and creator.
6. **Anyone can query it.** Click **copy curl** and run it with no key.
7. **Nothing private.** No column carries a nullifier, signature or verification record. See [schema.md](schema.md).

## Checks before recording

```sh
cd server && npx vitest run test/arkiv.test.ts   # 22 tests, no network
cd server && npx vitest run test/arkivProvenance.test.ts   # provenance: doubtful cases are unknown
cd web && npx vitest run src/lib/arkiv.test.ts   # schemas match the server, hash and comparison logic
```

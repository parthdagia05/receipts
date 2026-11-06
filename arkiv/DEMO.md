# Arkiv demo

A sequence anyone can reproduce. Steps marked **(write)** send an Arkiv transaction and need the publisher key. Every other step only reads.

## Before the demo (once)

1. **Publisher wallet.** Create a fresh key used only for Arkiv. It must not be the Record Server key; the CLI checks this against the gateway's `recordServerSigner` and refuses. Fund it from the [Rabdi faucet](https://hub.arkiv.network/faucet). One snapshot write was estimated by the node at **229,292 gas, about 0.00023 tGLM** at the current gas price of 1 gwei.
2. **Configure.**
   - `server/.env`: `ARKIV_PUBLISHER_PRIVATE_KEY`. Optionally `ARKIV_ACCESS_KEY` from [hub.arkiv.network/access-keys](https://hub.arkiv.network/access-keys).
   - `RPC_URL` must be an archive-capable Sepolia endpoint. A pruned public node fails with `pruned history unavailable`.
   - `web/.env`: `VITE_ARKIV_PUBLISHER_ADDRESS`. Rebuild the web app.
3. **Dry run** (read-only):
   ```sh
   cd server && npm run arkiv:publish -- --agents 1
   ```
   It prints every entity value, the publisher and its balance, a gas estimate and a `planHash`, and writes `arkiv-plan.json`.
4. **(write) Publish exactly that plan:**
   ```sh
   npm run arkiv:publish -- --execute --plan arkiv-plan.json --confirm <planHash>
   ```
   It prints the Arkiv transaction and an explorer link for every entity created.
5. Fill in the publisher address and entity keys wherever the docs say `<pending first publication>`: README, `arkiv/schema.md` and `arkiv/reach.md`.

## On camera (about 90 seconds)

1. **The problem.** Our API is behind an ephemeral tunnel, and the chain needs an archive node. Show `GET /api/agents/1/reputation` working.
2. **The agent page.** Open `/agents/1`. The **Public record on Arkiv** card shows:
   - the snapshot's score and status, and its Sepolia block;
   - the evidence hash;
   - "expires in 7 days";
   - a **Versus API now** row. The API rescores at the current head, so this compares standing (status, score, humans) rather than hashes. **Matches API** appears only in the rare case both are for the same block.
3. **Independent of us.** Stop the API container:
   ```sh
   docker compose -f docker-compose.prod.yml stop api
   ```
   Reload the page. The reputation stat fails, as it should, but the Arkiv card still answers because it queries Rabdi from the browser. Start the API again.
4. **Anyone can query it.** Click **copy curl** and run it in a terminal with no key. Then open the entity link in the [Rabdi explorer](https://rabdi.explorer.arkiv.network).
5. **Filtering across agents.** Run the "score ≥ 70" query from [how-you-use-arkiv.md](how-you-use-arkiv.md). Our API cannot answer it at all.
6. **Integrity.** For a mirrored review, the badge **Text matches on-chain hash** is computed in the browser: keccak256 of the Arkiv bytes against the `feedbackHash` signed on Sepolia. Open the Sepolia tx link beside it.
7. **Nothing private.** Show `arkiv/schema.md` "What is not on Arkiv", and that no column carries a nullifier.

## If there are still no on-chain reviews

Reviews appear on Arkiv only after a real `ReviewSubmitted` is confirmed on Sepolia. As of this writing none has been written (see the README status table). In that case the demo shows the reputation snapshot with status `no_eligible_reviews` and an empty review list, and says so. Do not seed simulated reviews: the review schema means "this happened on Sepolia".

## Checks to run before recording

```sh
cd server && npx vitest run test/arkiv.test.ts   # 18 tests, no network
cd web && npx vitest run src/lib/arkiv.test.ts   # web schemas match the server's
```

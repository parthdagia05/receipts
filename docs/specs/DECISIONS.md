# Decision records

Each record states what was decided, why, and the consequences. They were reconstructed from the code, the tests and `COORDINATION.md`; they are not contemporaneous minutes.

## ADR-1: A gateway in front of the ERC-8004 registry
**Decision.** Receipts feedback is written only by `ReviewGateway`, which requires a Record Server attestation. The reputation engine reads only that gateway's entries.
**Why.** The registry accepts feedback from anyone and summarises with a mean, so open writes move the score. A gate lets identity rules apply before writing.
**Consequences.** Trust concentrates in the Record Server key (single immutable signer). Feedback is attributed to the gateway address, not the human, so a `ReviewSubmitted` event is needed to recover the reviewer.

## ADR-2: Weighted median with a five-human threshold
**Decision.** Score is the lower weighted median of types 0 and 1, published only with at least five distinct verified humans. Integer micro-weights; paid reviews weigh 1.0 to 2.0.
**Why.** A median resists an attacker below half the weight; below five reviewers one person holds too much weight. Integer maths avoids rounding disagreements.
**Consequences.** Many agents show no score. Payment buys bounded extra weight.

## ADR-3: Wallet-only reviews are a separate type and never scored
**Decision.** Type 2 is accepted by the contract and the server but is excluded from the score, the human count and the threshold, and is labelled as not proving uniqueness.
**Why.** A wallet is not a person; one person can sign from any number of wallets. It is an accessible fallback for people without a World ID credential, recorded as the weaker claim it is.
**Consequences.** Wallet reviews exist in the registry and are visible, but carry no reputation weight.

## ADR-4: Payment adds weight but never replaces World ID
**Decision.** There is no wallet-plus-payment review type. A paid review requires World ID.
**Why.** Otherwise N wallets that each pay the minimum would cast N weighted votes. The contract cannot tell the cases apart, so the rule lives in the server.
**Consequences.** The on-chain tag for paid reviews is `receipt-verified`, but the label shown is "Human-verified · Paid".

## ADR-5: Wallet nullifier derived from the reviewer, recomputed on-chain
**Decision.** `walletNullifier(reviewer)` with a domain separator, recomputed in the gateway rather than taken from the attestation.
**Why.** Keeps one-review-per-wallet in the shared registry, prevents collision with World ID nullifiers, and stops a faulty server from giving one wallet two nullifiers.
**Consequences.** The server and engine must derive the identical value, pinned by a shared test vector.

## ADR-6: Separate table for wallet challenges
**Decision.** Migration `006_wallet_review_authorizations` adds a new table rather than loosening `review_authorizations`, whose `verification_nonce` is a required foreign key to a World ID verification. The table has `CHECK` constraints on type, receipt and ranges, and a partial unique index on spent rows per (agent, reviewer). PostgreSQL schema version 2 mirrors it.
**Why.** SQLite cannot drop NOT NULL in place, and nullable verification would weaken a guarantee other paths rely on.
**Consequences.** `attest` must look in both tables and check that the type matches the table. An upgrade from PostgreSQL schema version 1 to 2 was checked inside a rolled-back transaction: the table appears, existing rows are kept, and re-applying is harmless.

## ADR-7: Wallet reviews behind a flag, off by default
**Decision.** `WALLET_REVIEWS_ENABLED` defaults to false and is parsed strictly. The web app offers the wallet flow only when the server reports it enabled.
**Why.** The deployed gateway cannot accept wallet reviews, so attestations issued for it would revert.
**Consequences.** A gateway redeployment, which is a human decision and has not been done, is a precondition for enabling it.

## ADR-8: Multi-gateway reputation
**Decision.** Retrieval takes a list of gateways with their own start blocks (`ADDITIONAL_REVIEW_GATEWAYS`).
**Why.** Replacing the gateway would otherwise drop all earlier reviews from scores. The shared `NullifierRegistry` already survives replacement.
**Consequences.** Needs the setting to be passed through deployment configuration. The web app's review list still reads one gateway.

## ADR-9: Versioned, hashed evidence manifest
**Decision.** The reputation response carries a canonical manifest and its keccak256 hash, with a spec version.
**Why.** So a third party can recompute a score from chain data.
**Consequences.** Hashes differ across spec versions by design.

## ADR-10: ENS is out of scope
**Decision.** ENS is not implemented.
**Why.** It was considered as an add-on and kept off the core review flow.
**Consequences.** Nothing in this repository integrates with ENS. (This ADR originally covered Arkiv too; ADR-11 supersedes that part.)

## ADR-11: Arkiv as a public read model, not a source of truth
**Decision.** Confirmed reviews and per-agent reputation snapshots are published to Arkiv (Rabdi testnet) as `receipts.review/v1` and `receipts.reputation/v1` entities, by a separate CLI with its own key. The agent page reads them from Arkiv in the browser.
**Why.** The score is useful to apps that are not ours. Without Arkiv they must reach our server, which runs behind an ephemeral tunnel, or replay gateway logs on an archive node. Arkiv gives them indexed, attributable, keyless reads.
**Consequences.**
- PostgreSQL and Sepolia stay authoritative, and nothing on Arkiv is read back into scoring.
- Nullifiers, the manifest, signatures and authorizations are never published.
- Every read must filter on `$creator`, because anyone can write under the tags.
- A publish is a dry run until a human confirms the hash of the exact plan file.
- See [arkiv/](../../arkiv/).

# Threat model

This is a reading of the code and tests by an AI session, written for the submission. **It is not an audit**, and nothing here is a security guarantee. "Mitigated" means a mechanism exists and has tests, not that it has been proven or externally reviewed.

## Assets

Integrity of the published score and labels; one-review-per-identity; the Record Server signing key; review content integrity; availability of the server and its RPC and World ID dependencies.

## Trust assumptions

1. **The Record Server is trusted.** The gateway accepts any attestation signed by one immutable EOA, `recordServerSigner`. The server decides what counts as a human, a payment-backed review or a wallet-signed one. The contract checks the signature, the rating range, the owner/operator rule, the receipt and the nullifier uniqueness, but **cannot verify a World ID proof**. "Human-verified" is therefore a server claim, and compromise of the key or a bug in the server could forge it.
2. **World ID is trusted** to issue one nullifier per person per action. This was **not tested against the live service**.
3. The ERC-8004 registries, USDC and the RPC provider behave as documented. The deployed registry addresses are those in the project's config; whether they are the official ERC-8004 deployment was not verified.

## Risks and mitigations

| Risk | Mitigation (and its limit) |
|---|---|
| **Sybil with wallets.** A wallet nullifier is derived from an address; one person can hold many. | Wallet-verified reviews are excluded from the score, the human count and the threshold, and labelled as not proving uniqueness. They remain visible, so a consumer reading the raw registry sees them. |
| **Payment mistaken for uniqueness.** | Paid reviews still require World ID in the server flow. Payment only adds weight, capped at 2x. A wallet-plus-payment type does not exist. A rich attacker can still buy weight per identity. |
| **Wallet identity posing as human.** A buggy or compromised server signs type 0 or 1 with a wallet nullifier. | The engine excludes any type 0 or 1 review whose nullifier equals the wallet derivation of its reviewer, and excludes reviews with no usable reviewer. This covers that one forgery, not forged World ID nullifiers in general. |
| **Type confusion through client input.** | The server derives `reviewType` from the flow. The wallet endpoint accepts a fixed set of fields and rejects others; the World ID `prepare` endpoint rejects type 2; `attest` maps types to functions through an explicit table and refuses a type that disagrees with the table it came from. |
| **Replay and double submission.** | Single-use random challenge ids; EIP-712 domain bound to chain and gateway; signatures cover agent, reviewer, value, hash, type, nullifier, nonce and deadline; unique `(agent, nullifier)` in the database and in `NullifierRegistry`; partial unique index on spent wallet challenges (tested on PostgreSQL with parallelism). |
| **Content swapping.** | The server hashes the content itself; the attestation is signed over a `feedbackURI` derived from the hash; the content table is append-only through database triggers. |
| **Manipulation of the score.** | Weighted median with a five-human threshold; duplicate nullifiers resolved before eligibility; revoked and unreadable entries excluded. See the limits in `REPUTATION_SPEC.md`. |
| **Gateway replacement drops history.** | The engine supports several gateways, and the shared `NullifierRegistry` preserves uniqueness. It depends on `ADDITIONAL_REVIEW_GATEWAYS` being set, which `docker-compose.prod.yml` does not currently pass through. |
| **Contract wallet signature state.** ERC-1271 validity can change after verification. | Verification is pinned to a block hash and refused for counterfactual (ERC-6492) signatures. A signer rotation after the check is not caught. |
| **Unauthenticated endpoints.** | Global and per-route rate limits, size limits on content (16 KiB) and signatures (4 KiB). **Open issue:** `POST /api/reviews/wallet/prepare` stores review content in an append-only table before any signature, with no proof-of-human gate, so an anonymous caller could grow it and host arbitrary text at `/reviews/<hash>`. This should be fixed before the wallet flag is enabled in any deployment. |
| **ERC-8004 registry pollution.** Wallet-verified feedback is written under the same client address as human feedback. | Cannot be fixed on-chain. Consumers of the registry's own mean must filter by `tag2`. The Receipts score is unaffected. |
| **Secrets.** Record Server key, World signing key, RPC URL, database URL. | Read from the environment, redacted in logs and error bodies, never sent to clients. Handling in real deployments was not reviewed here. |

## Known gaps

- Live World ID verification, on-chain wallet submission and the infrastructure code were not exercised in this review.
- The signing challenge for a wallet review is spent when the attestation is issued; because nothing can be submitted on-chain yet, that wallet is blocked from repeating it for that agent.
- No external audit, fuzzing beyond the included tests, or formal verification.

# Reputation specification (`receipts-reputation/1.1`)

Source: `server/src/reputation/{spec,engine,retrieval,evidence}.ts` and `server/src/routes/reputation.ts`. Tests: `server/test/reputation*.test.ts`.

## Inputs

Only reviews written by the Receipts gateway(s) for the agent are considered: `NewFeedback` events from the ERC-8004 Reputation Registry filtered to `clientAddress = <gateway>`, paired with that gateway's `ReviewSubmitted` event from the same transaction and cross-checked on `feedbackHash`. A transaction with more than one event of either kind, or a pair that disagrees, is not attributed and is listed under `unattributable` in the manifest.

Retrieval fails closed:

- Each type has an explicit rule for its tag2 and receipt: type 0 needs `human-verified` and a zero receipt; type 1 needs `receipt-verified` and a non-zero receipt; type 2 needs `wallet-verified` and a zero receipt. Any mismatch, or an unknown type, is `unattributable`.
- Every candidate needs an explicit revocation status read at the snapshot block. A missing status makes it unattributable. It is never assumed live.
- A receipt cited by more than one review, unreadable, or not matching the review's payer and agent gets no payment weight.
- All reads are pinned to one snapshot block (head minus `REPUTATION_CONFIRMATIONS`). A manifest describes that block; it is not a finality guarantee.

### Multiple gateways

`retrieveReviews` accepts a list of gateways, each with its own deployment block, merged by address (earliest block wins, so a repeated address is never scanned twice). Revocation state is read per gateway and keyed by gateway and index, because ERC-8004 numbers feedback per client. The server builds the list from `REVIEW_GATEWAY_ADDRESS` plus `ADDITIONAL_REVIEW_GATEWAYS`. This is tested with mocked chain clients, **not against live chain data**.

## Scoring (types 0 and 1 only)

1. **Wallet reviews leave first.** Type 2 reviews are separated before deduplication, eligibility, weighting or the median. There is no code path from a wallet review to the human score.
2. **Deduplicate by nullifier across all remaining candidates, before eligibility.** The earliest by block, then log index, then feedback index wins; later ones are excluded as `duplicate_nullifier`. This stops a person from revoking and resubmitting to vote again.
3. **Classify.** Excluded with a reason: `revoked`, `invalid_decimals` (must be 0), `rating_out_of_range` (0 to 100), `unknown_review_type`, `missing_reviewer` or `invalid_reviewer`, `wallet_nullifier_on_human_review` (a type 0 or 1 whose nullifier equals `walletNullifier(reviewer)`), `missing_payment` (a paid review whose receipt could not be read).
4. **Weights**, in integer micro-weight units (1 weight = 1,000,000): free review = 1.0. Paid review = `1 + min(amount / 10, 1)` where `amount` is in USDC base units (6 decimals) and `amount / 10` is already micro-weight. So 1 USDC adds 0.1 and 10 USDC or more adds the cap of 1.0. A paid review therefore weighs between 1.0 and 2.0 (the gateway enforces a 1 USDC minimum, so on the deployed gateway, at least 1.1). Integer arithmetic only.
5. **Threshold.** No score is published below `MIN_DISTINCT_HUMANS = 5` eligible, distinct verified humans, counted after every exclusion. Status is `no_eligible_reviews`, `below_threshold` or `published`.
6. **Lower weighted median.** Sort ascending by value (ties by nullifier), accumulate weights, and return the first value whose cumulative weight satisfies `2 * cumulative >= total`. No interpolation.

Why a median: a mean can be moved by any single large outlier, while a median cannot be pushed outside the range of honest values by an attacker holding less than half of the total weight. The repository has property tests for the engine (`reputationProperty.test.ts`). This is a design argument plus tests, **not a formal proof**, and it assumes the attacker cannot mint many World ID identities. Payment weight lets a well-funded attacker buy up to 2x weight per identity.

## Tiers

| Tier | Contents | Score |
|---|---|---|
| `human` | Types 0 and 1. Equals the top-level legacy score. | median, threshold 5 |
| `receipt` | Type 1 only. A **subset** of `human`. | median, threshold 5 |
| `wallet` | Type 2. Deduplicated, and valid only if the nullifier is the wallet derivation of the recorded reviewer. | none; informational, weight 0, threshold 0 |

The top-level `distinct_humans` equals `tiers.human.count`. Wallet reviews never appear in it.

## Evidence manifest

The response includes a manifest naming the spec version, snapshot block, contracts (and all gateways when more than one), every eligible review with its weight, every exclusion with its reason, the wallet records, and unattributable records. It is serialised canonically (sorted keys, no whitespace, integers as decimal strings) and hashed with keccak256 (`evidence_hash`).

Version 1.1 added the `tiers` and `wallet` sections and optional `gateway` fields, and changed `spec`. A v1.1 hash therefore differs from the v1.0 hash of the same chain state **by design**. Compare hashes only within one `spec` value, and only for the same snapshot block.

## Limits

- The engine trusts the type and nullifier the gateway recorded. The contract cannot tell a World ID nullifier from another value (see the threat model).
- The score has been exercised in unit and mocked-chain tests, not against live chain data in this documentation pass.

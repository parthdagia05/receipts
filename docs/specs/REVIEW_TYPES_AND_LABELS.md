# Review types and labels

## Identifiers

| `reviewType` | Name | Gateway function | ERC-8004 `tag2` | Nullifier | `receiptId` |
|---|---|---|---|---|---|
| 0 | Human-verified (`FREE`) | `submitFreeReview` | `human-verified` | World ID nullifier, converted to `bytes32` from a stored verification | zero |
| 1 | Paid-human (`PAID`) | `submitPaidReview` | `receipt-verified` | World ID nullifier, as above | non-zero (a settled, unspent receipt) |
| 2 | Wallet-verified (`WALLET`) | `submitWalletReview` | `wallet-verified` | `walletNullifier(reviewer)` | zero |

`tag1` is always `quality`; `valueDecimals` is always 0; the rating is an integer 0 to 100.

`walletNullifier(reviewer) = keccak256(abi.encode(keccak256("ReceiptsWalletReview(v1)"), reviewer))`. The gateway recomputes it on-chain and rejects any other value for type 2. The server and the reputation engine derive the same value. A fixed address (`0x1111…1111`) was checked to give `0x1a15214e097dba6523a50a955435a209d2c4e80e05291155c8847a2241168c4d` with `cast` and with the TypeScript implementation.

Any other `reviewType` value is unknown. It is refused by the server's validators and excluded by the reputation engine, and the web app renders it as "Unverified".

## What each type proves

- **Human-verified (0).** The Record Server verified a World ID Proof of Human whose signal is bound to the reviewer's wallet, for the action `review-agent-<agentId>`. One review per person per agent, enforced by a unique `(agent, nullifier)` in the server database and by the on-chain `NullifierRegistry`. This is a claim made by the Record Server; see the threat model.
- **Paid-human (1).** Everything in type 0, plus a USDC payment from the reviewer to that agent through `ReceiptSettler`. The gateway consumes the receipt, which is single-use, bound to payer and agent, above a minimum amount and within 30 days.
- **Wallet-verified (2).** A wallet signed an EIP-712 authorization for this exact review. Nothing is claimed about the person behind the wallet, and one person can control many wallets. Uniqueness is one review per wallet address per agent.

**Payment is not human uniqueness.** A receipt proves an address paid. In this system a paid review still requires World ID; the payment only adds weight (see `REPUTATION_SPEC.md`). A review that combined wallet-only identity with payment would let one person cast many weighted votes by paying from many wallets. No such type exists. If one were ever added it would need its own type and tag and would not be scored as human.

## Labels shown to users

| API / UI key | Label | Tooltip |
|---|---|---|
| `world_id_human` | Human-verified | A unique person proved they are human with World ID Proof of Human. |
| `world_id_human_paid` | Human-verified · Paid | The same, and the person paid the agent with a settled USDC receipt. |
| `wallet_only` | Wallet-verified | A wallet signed this review. This does not prove one person, since one person can control many wallets. Not counted in the reputation score. |
| `unverified` | Unverified | Unknown or inconsistent verification type. |

The web function `verificationOf(reviewType, tag2?)` maps type (and tag2 when known) to the key. Any combination other than the three known pairs is `unverified`, and a tag that contradicts the type never upgrades a review.

The on-chain tag for type 1 is `receipt-verified`. The UI says "Paid" because "receipt-verified" alone would suggest payment is the whole claim.

## Where this is enforced

- Contract: `ReviewGateway.sol` (entry points, tags, wallet nullifier recomputation).
- Server: `signing/reviewContent.ts` (types, shared validation), `routes/reviewAttest.ts` (explicit type to function table), `routes/walletReviewPrepare.ts`.
- Reputation: `reputation/spec.ts`, `engine.ts`, `retrieval.ts`.
- Web: `web/src/lib/reviews.ts`, `VerificationBadge`, `ReputationTiers`.

# Record Server API (as implemented)

All bodies are JSON. Integers that may exceed 2^53 (agent ids) are decimal strings. Errors are `{ "error": "<code>", "message"?, "issues"? }`; error bodies for internal faults are deliberately opaque. A global rate limit applies (120 requests per minute per client), with tighter limits on `/api/reviews/verify`, `/api/agents/*` and `/api/reputation/simulate`.

## Human-verified and paid flow

| Endpoint | Request | Success response |
|---|---|---|
| `POST /api/world-id/request` | `{ agentId }` | `{ app_id, action, rp_context }`. The action is derived from the agent id on the server. |
| `POST /api/reviews/verify` | `{ agentId, reviewer, proof }` (the IDKit result) | `{ agent_id, reviewer, nullifier, verified_at }`. The nullifier is the one World ID returned. |
| `POST /api/reviews/prepare` | `{ agentId, reviewer, value, valueDecimals, reviewType, content, requestNonce, receiptId? }` | `{ challenge_id, deadline, feedback_hash, typed_data }` |
| `POST /api/reviews/attest` | `{ challengeId, signature }` | `{ attestation, gateway, submit_function, submitted: false }` |

Notes:

- `prepare` rejects `reviewType` 2 (wallet reviews have their own endpoint). The `feedback_hash` is computed from `content` by the server and the text is stored under it.
- `attest` takes every review field from the stored challenge. `submit_function` comes from an explicit table: 0 to `submitFreeReview`, 1 to `submitPaidReview`, 2 to `submitWalletReview`. An unknown stored type returns `unsupported_review_type` (500) and nothing is signed.
- `submitted` is always `false`: this endpoint signs, it does not send a transaction.

## Wallet-verified flow

| Endpoint | Request | Success response |
|---|---|---|
| `GET /api/reviews/wallet/status` | none | `{ enabled: boolean }` (always 200) |
| `POST /api/reviews/wallet/prepare` | `{ agentId, reviewer, value, valueDecimals, content }` | `{ challenge_id, deadline, feedback_hash, typed_data, review_type: 2, verification: "wallet_only" }` |

- Only the five request fields are accepted. Any other key (`reviewType`, `receiptId`, `nullifier`, `requestNonce`, a typo) returns `400 unknown_fields`.
- With `WALLET_REVIEWS_ENABLED` off (the default), `prepare` returns `503 wallet_reviews_disabled`, and `attest` refuses a wallet challenge with the same code even if it was issued earlier.
- Errors specific to this flow: `wallet_already_reviewed` (409), `nonce_consumed` (409).
- The signature is then exchanged at `POST /api/reviews/attest`, which returns `submit_function: "submitWalletReview"`. **The deployed Sepolia gateway cannot accept that call.**

## Content and reputation

| Endpoint | Description |
|---|---|
| `GET /reviews/:feedbackHash` | Returns the exact bytes that hash to `feedbackHash`, or 404. Content is append-only. |
| `GET /api/agents/:agentId/reputation` | Mounted only when the settler, identity registry and reputation registry addresses are configured. Response below. 503 `chain_read_failed` if the chain cannot be read. |
| `POST /api/reputation/simulate` | Demo only. Body `{ reviews: [{ value, reviewType, paymentAmount?, revoked? }] }` (1 to 500). Returns `simulated: true`, the engine's result, the plain mean for comparison, `tiers`, and a `wallet_effect` block comparing the human score with and without wallet reviews. No chain access and no evidence hash. |
| `GET /health` | `{ status, uptimeSeconds, checks: { database } }` |

### Reputation response

```jsonc
{
  "agent_id": "7",
  "status": "published" | "below_threshold" | "no_eligible_reviews",
  "score": 82 | null,          // weighted median of types 0 and 1 only
  "threshold": 5,
  "distinct_humans": 5,        // types 0 and 1 only. Never includes wallet reviews.
  "human_verified": 3,         // type 0
  "receipt_verified": 2,       // type 1 (World ID human AND paid)
  "total_weight": "7400000",   // micro-weight, decimal string
  "snapshot_block": "…",
  "evidence_hash": "0x…",
  "evidence": { /* manifest, spec receipts-reputation/1.1 */ },
  "unattributable": [],
  "tiers": {                   // additive
    "human":   { "score": 82, "count": 5, "threshold": 5, "status": "published", "totalWeight": "…" },
    "receipt": { "score": null, "count": 2, "threshold": 5, "status": "below_threshold", "totalWeight": "…" },
    "wallet":  { "score": null, "count": 11, "threshold": 0, "status": "informational", "totalWeight": "0" }
  }
}
```

- `tiers.receipt` is a subset of `tiers.human` (a paid review is also human-verified), so the two counts must not be added.
- `tiers.wallet` never has a score or weight.
- The values above are illustrative, not real data. `tiers.*` keys are camelCase inside an otherwise snake_case envelope, as implemented.

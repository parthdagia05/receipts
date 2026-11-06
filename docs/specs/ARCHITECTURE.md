# Architecture

## Components

| Component | Location | Role |
|---|---|---|
| `ReviewGateway` | `src/ReviewGateway.sol` | The only writer of Receipts feedback to the ERC-8004 Reputation Registry. Verifies an EIP-712 attestation signed by the Record Server (`recordServerSigner`, an immutable EOA), enforces one review per identity per agent, rejects the agent's owner/operator, and writes feedback tagged `quality` plus a type-specific tag2. Three entry points: `submitFreeReview`, `submitPaidReview`, `submitWalletReview`. Emits `ReviewSubmitted`. |
| `ReceiptSettler` | `src/ReceiptSettler.sol` | Settles a USDC payment using EIP-3009 `receiveWithAuthorization` and forwards it to the agent's wallet, recording a single-use receipt keyed by the authorization nonce. The nonce is `keccak256(abi.encode(agentId, orderId, chainid, settler))`, which binds the payment to one agent. It also holds the pointer to the **active** gateway (`reviewGateway`), set only by its deployer. |
| `NullifierRegistry` | `src/NullifierRegistry.sol` | Shared ledger `(agentId, nullifier) -> used`. Writable only by whichever gateway the settler names as active, so it survives a gateway replacement. |
| Record Server | `server/` | Verifies World ID proofs, issues EIP-712 challenges, verifies the reviewer's wallet signature (EOA, or ERC-1271 for contract wallets, pinned to a block hash), and signs attestations. Serves review text at `/reviews/:feedbackHash`. Computes the reputation score. |
| Reputation engine | `server/src/reputation/` | Pure weighted-median calculation (`engine.ts`), chain retrieval (`retrieval.ts`), evidence manifest (`evidence.ts`), constants (`spec.ts`). |
| Web app | `web/` | Review wizard, reputation views, docs page and a simulated attack demo. Reads reviews from `ReviewSubmitted` logs of one gateway. |

## Flows

### Human-verified review (type 0)

1. Browser asks `POST /api/world-id/request` for an RP-signed World ID request. The action is `review-agent-<agentId>`, derived server-side.
2. User completes IDKit; browser posts the result to `POST /api/reviews/verify`. The server checks the action, environment, Proof of Human credential and that the signal is bound to the reviewer wallet, then asks World ID to verify and stores the returned nullifier, one per `(agent, nullifier)`.
3. `POST /api/reviews/prepare` takes the verified request nonce plus the review content. The server hashes the content itself, stores it under that hash and returns EIP-712 typed data for the wallet.
4. The wallet signs. `POST /api/reviews/attest` verifies the signature against typed data rebuilt from storage, consumes the challenge once, and returns the gateway attestation signed by the Record Server key, with `feedbackURI` derived from the hash.
5. The reviewer's own transaction calls `submitFreeReview(attestation)`. The gateway verifies the signature, consumes the nullifier and writes the ERC-8004 feedback.

Steps 1 to 4 are implemented and unit-tested. They have **not** been exercised against the live World ID service. Step 5 is implemented in the contract and in the web app for type 0 only.

### Paid-human review (type 1)

As above, plus a prior `ReceiptSettler.settle(...)` payment by the same wallet to the same agent. The attestation carries the `receiptId`; the gateway consumes the receipt, enforces a minimum payment and a 30-day review window. Implemented in contracts and server and tested. **No paid flow exists in the web UI.**

### Wallet-verified review (type 2)

1. `POST /api/reviews/wallet/prepare` (only when `WALLET_REVIEWS_ENABLED=true`). The server fixes `reviewType = 2`, a zero `receiptId` and the nullifier `walletNullifier(reviewer)`.
2. The wallet signs; `POST /api/reviews/attest` returns an attestation with `submit_function = submitWalletReview`.
3. **The flow stops there in the web app.** The deployed gateway has no `submitWalletReview`, so nothing is sent on-chain and the UI says so.

### Reputation

`GET /api/agents/:agentId/reputation` reads `NewFeedback` and `ReviewSubmitted` logs for the gateway (and any configured additional gateways), pairs them per transaction, reads revocation state and receipts at a pinned snapshot block, runs the engine and returns the score with an evidence manifest and its hash.

## Data stores

SQLite (development) or PostgreSQL (required in production). Tables: `world_id_requests`, `world_id_verifications`, `review_authorizations`, `review_contents` (append-only), and `wallet_review_authorizations` (migration `006`). The PostgreSQL schema is a single file, applied idempotently at boot, schema version 2.

## Deployment state

See the README: contracts are deployed on Sepolia with consistent wiring, but the live gateway predates the wallet path, and no review or receipt has been recorded on them. Nothing in this repository claims a production deployment of the server or web app.

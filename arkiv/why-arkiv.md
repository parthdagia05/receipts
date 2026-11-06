# Why Arkiv

## If this data lived only in our PostgreSQL, what would users lose?

Receipts scores ERC-8004 agents with a weighted median over reviews that are bound to a World ID human and, optionally, a settled payment. The people who need that score are mostly not on our website. They are agent marketplaces, wallets, and other agents deciding whom to pay. Today they have two ways to get it, and both are weak:

1. **Ask our server.** `GET /api/agents/:id/reputation` works only while our Record Server is up. For this hackathon it runs behind a Cloudflare Quick Tunnel whose URL changes on every restart. The signed `feedbackURI` in every on-chain review points at that URL, so a restart orphans every link to review text.
2. **Recompute from the chain.** This means replaying `ReviewSubmitted` and `NewFeedback` logs from the gateway's deploy block. We hit the limits of this ourselves while building: a public Sepolia endpoint answered `pruned history unavailable` for a 20,000-block log query. Recomputing in practice requires an archive node.

With the data on Arkiv, a consumer instead:

- **Queries it without us.** A curl to the public Rabdi RPC returns the latest snapshot or the reviews for an agent. It needs no API key, no Receipts server and no archive node, and CORS is open, so a browser app can do the same. Our own agent page reads this way: the Arkiv card keeps working when the Record Server is down.
- **Filters across agents.** "Published score ≥ 70 with at least 5 distinct humans" is one indexed query over `receipts.reputation/v1`. Our API answers one agent at a time and has no search. Building one would be another service for us to run and for consumers to trust.
- **Knows who said it.** `$creator` is the publisher wallet, recorded by the chain, not claimed in the payload. A consumer filters on it and ignores anything else written under our tag.
- **Can check it.** Each review carries its text and the `feedbackHash` that was signed on Sepolia. The web app recomputes the hash in the browser and shows whether they match. Each snapshot carries the evidence manifest hash the API serves for the same block.
- **Gets the freshness rule in the data.** A snapshot expires after 7 days unless it is renewed, so a score that has gone stale disappears instead of lingering. Reviews are extendable by anyone, so an agent that wants its history kept can keep it alive itself.

## What did we keep off Arkiv, and why?

| Kept off | Why |
|---|---|
| World ID nullifiers | A nullifier is the anonymous identity key for one human and one agent. Publishing it in an easy-to-query form would make it trivial to link one person's reviews. The indexer drops it on decode. |
| The evidence manifest | It lists nullifiers. Only its hash is published. |
| World ID requests and verifications, review authorizations, EIP-712 signatures | Private or security-sensitive state that only the Record Server needs. |
| The authoritative review database | PostgreSQL stays the source of truth. Its `UNIQUE (agent_id, nullifier)` constraint is what enforces one review per human per agent. Arkiv is a public read model, never read back into scoring. |
| Unconfirmed reviews | A review is published only 12 Sepolia blocks after it lands. A `readonly` entity for a transaction that was reorged out could not be corrected. |
| Signing keys | The Arkiv publisher key is separate from the attestation key, and the API server never holds it. |

## Honest limits

- **The publisher is still trusted.** Arkiv makes the record public and attributable, not trustless. A consumer who doubts us can check `feedbackHash` and `txHash` against Sepolia, and `manifestHash` against the API or a recomputation.
- **No entity lives more than about 182 days.** Permanent history is on Sepolia. Arkiv holds the queryable copy, kept alive by renewal.

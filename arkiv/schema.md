# Arkiv schema

Receipts publishes two kinds of entity to Arkiv's Rabdi testnet (chain `7794095`). Both are defined in [`server/src/arkiv/schemas.ts`](../server/src/arkiv/schemas.ts). The web app keeps a copy in [`web/src/lib/arkiv.ts`](../web/src/lib/arkiv.ts), and a test fails if the two drift apart.

| | `receipts.review/v1` | `receipts.reputation/v1` |
|---|---|---|
| One entity per | confirmed `ReviewSubmitted` event on Sepolia | agent, each time its standing changes |
| Owner and creator | the Receipts publisher wallet | the Receipts publisher wallet |
| Who can change it | nobody: created `readonly` | nobody: created `readonly` |
| Who can extend it | anyone (`permissionlessExtension`) | the publisher only |
| Expires | max lifetime (7,884,000 blocks, about 182 days), renewed by the publisher when under 30 days remain | 7 days, renewed while the standing is unchanged, otherwise superseded |

**Publisher wallet:** [`0x98A4e58bB26ced2656e260DDb62C915465ce4b3e`](https://rabdi.explorer.arkiv.network/address/0x98A4e58bB26ced2656e260DDb62C915465ce4b3e). It is a dedicated key, used for nothing else. The CLI refuses to run if it equals the gateway's `recordServerSigner`, the key that signs review attestations.

Arkiv lets anyone create entities under any schema tag. **Every query must filter on `$creator`** equal to the publisher address. The web app and every query below do.

## `receipts.review/v1`

| Column | Type | Indexed | Meaning |
|---|---|---|---|
| `agentId` | `str` | yes | ERC-8004 agent id, decimal |
| `chainId` | `u64` | yes | `11155111` (Sepolia) |
| `gateway` | `addr` | yes | ReviewGateway that emitted the review |
| `reviewer` | `addr` | yes | reviewing wallet, as recorded on-chain |
| `reviewType` | `i32` | yes | `0` human-verified, `1` human-verified and paid, `2` wallet-verified |
| `tag` | `str` | yes | ERC-8004 tag2: `human-verified`, `receipt-verified`, `wallet-verified` |
| `value` | `i32` | yes | rating, 0 to 100 |
| `valueDecimals` | `i32` | no | always `0` |
| `feedbackIndex` | `u64` | yes | ERC-8004 feedback index for (agent, gateway) |
| `feedbackHash` | `str` | yes | keccak256 of `content`, as signed on-chain |
| `receiptId` | `str` | no | settled USDC receipt; paid reviews only |
| `txHash` | `str` | yes | Sepolia transaction |
| `logIndex` | `i32` | no | log index of `ReviewSubmitted` |
| `blockNumber` | `u64` | yes | Sepolia block |
| `content` | `bytes` | no | the review text; included only if it hashes to `feedbackHash` |
| `contentType` | `str` | no | `text/plain; charset=utf-8` |
| `worldIdEnvironment` | `str` | yes | `production`, `staging` (World ID Simulator test), `none` (wallet review) or `unknown`. See below |
| `worldIdRpId` | `str` | no | World ID RP the proof went through, when known. Public: every IDKit request shows it |

The fields filtered on are `agentId`, `reviewType`, `value`, `reviewer`, `txHash`, `feedbackHash` and `$creator`. Sorting uses `blockNumber`.

## `receipts.reputation/v1`

| Column | Type | Indexed | Meaning |
|---|---|---|---|
| `agentId` | `str` | yes | ERC-8004 agent id |
| `chainId` | `u64` | yes | `11155111` |
| `spec` | `str` | yes | scoring ruleset, `receipts-reputation/1.1` |
| `status` | `str` | yes | `published`, `below_threshold`, `no_eligible_reviews` |
| `score` | `i32` | yes, optional | weighted median, 0 to 100; absent until 5 distinct verified humans |
| `distinctHumans` | `i32` | yes | distinct World ID humans counted |
| `threshold` | `i32` | no | humans needed for a score (5) |
| `humanVerifiedCount` / `receiptVerifiedCount` | `i32` | no | eligible reviews per type |
| `receiptScore` / `receiptStatus` | `i32` (optional) / `str` | no | the paid-only tier |
| `walletCount` | `i32` | no | wallet-verified reviews; informational, never scored |
| `totalWeight` | `str` | no | sum of weights in millionths |
| `unattributableCount` | `i32` | no | on-chain records that could not be attributed |
| `snapshotBlock` | `u64` | yes | Sepolia block the score was computed at |
| `manifestHash` | `str` | yes | keccak256 of the canonical evidence manifest; equals the API's `evidence_hash` for the same block |
| `reviewGateway` | `addr` | no | gateway scored |
| `productionVerifiedCount` | `i32` | no | the agent's human-labelled reviews verified with production World ID |
| `stagingVerifiedCount` | `i32` | no | the same, verified with staging World ID (Simulator tests) |
| `unknownProvenanceCount` | `i32` | no | the same, with no provenance on record |

The fields filtered on are `agentId`, `status`, `score`, `distinctHumans` and `$creator`. Sorting uses `snapshotBlock`.

## World ID provenance

Sepolia does not record which World ID environment verified a review. A `human-verified` tag only says the Record Server signed it, and the Record Server also signs for staging World ID, which only accepts the World ID Simulator. So the publisher adds this from Receipts' own records:

- For each review it looks up the World ID request the review's authorization used, and reads only that request's RP id. Databases are opened read-only. Nullifiers, signatures and nonces are never selected.
- The RP id is mapped to an environment with `ARKIV_RP_ENVIRONMENTS`. Production RP `rp_d3afb91156ea1942`, staging RP `rp_c357f900d4501523`.
- No record, two sources that disagree, or an RP not in the map all give `unknown`. Nothing is guessed.
- Wallet-verified reviews are `none`.

This is the publisher's statement, not something a reader can check on-chain. A snapshot whose counts include staging reviews is a test score, and the app labels it that way.

## What is not on Arkiv

- **World ID nullifiers.** They are dropped while the Sepolia event is decoded ([`indexer.ts`](../server/src/arkiv/indexer.ts)). The evidence manifest lists them, so only its hash is published. A test fails if any column is named after a nullifier, signature, proof or nonce.
- **World ID requests and verifications, review authorizations, EIP-712 signatures and the database itself.** They stay in PostgreSQL.
- **Anything not already public.** Every published value is either on Sepolia or served at `/reviews/:feedbackHash`.

## Queries

Copy-paste versions with the real publisher address are in the [README](../README.md#arkiv). Replace `<PUBLISHER>`:

```sql
-- every review of agent 1
arkiv.schema = str('receipts.review/v1') AND agentId = str('1') AND $creator = addr(<PUBLISHER>) ORDER BY blockNumber:u64 DESC

-- latest reputation snapshot for agent 1
arkiv.schema = str('receipts.reputation/v1') AND agentId = str('1') AND $creator = addr(<PUBLISHER>) ORDER BY snapshotBlock:u64 DESC

-- agents with a published score of at least 70
arkiv.schema = str('receipts.reputation/v1') AND status = str('published') AND score >= 70 AND $creator = addr(<PUBLISHER>)
```

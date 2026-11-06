# Arkiv feedback

What it was like adding Arkiv to Receipts at ETHGlobal Mumbai, with `@arkiv-network/sdk` 1.0.1 on Rabdi. Each point says what we hit and what would have helped.

## What worked well

- **Typed schemas.** `defineSchema` with `.indexed()` / `.optional()` caught type mistakes at compile time. The SDK also validates every create against its schema before the first network call, so a bad value fails locally, not as a revert.
- **Keyless, CORS-open reads.** `arkiv_query` on the public RPC needs no key and answers `access-control-allow-origin: *`. Our web app reads Arkiv directly from the browser with nothing in the bundle, and judges can curl it.
- **`query.toString()`** prints the exact query-language string the builder sends. We show it to users as a copyable curl command, and it ran unchanged against raw JSON-RPC.
- **Creation flags.** `readonly` plus `permissionlessExtension` describe precisely the guarantee we wanted for published reviews: nobody can edit them, anybody can keep them alive.

## Friction

1. **No way to estimate or preview a batch without sending it.** We wanted to show the exact cost before asking a human to approve a write. The SDK estimates gas internally, inside `executeBatch`, but exposes no `estimateBatch` / `prepareBatch`. We ended up wrapping the transport so it forwards reads to the node and throws on `eth_sendRawTransaction` (`estimatePlan` in `server/src/arkiv/sdk.ts`). **Would help:** `walletClient.estimateBatch(...)` returning gas and encoded calldata.
2. **No public encoder for offline validation.** `encodeCreate` and `createOperation` exist but are not exported. To test that our values satisfy the schema without a network, we used a fake transport and checked how far the SDK got. **Would help:** export a pure `validateCreate(schema, values)`.
3. **Anyone can write under any schema tag.** The docs say so, but it is easy to miss, and a reader who filters by tag alone gets spoofable data. Every query we wrote needed `.createdBy(publisher)`. **Would help:** a warning when a query has a schema tag but no `$creator`/`$owner` filter, or namespaced tags tied to an owner.
4. **Explorer URL patterns are undocumented.** We found `/entity/<key>`, `/tx/<hash>` and `/address/<addr>` by reading the explorer's JavaScript bundle. **Would help:** one line in the Rabdi network page.
5. **Mixed-schema `executeBatch` is hard to type.** Mapping one array of plans into `creates` of two different schemas forced an `as never` cast. TypeScript can't infer the per-element schema tuple from a mapped array. **Would help:** an overload that takes `CreateEntityParameters<Schema>[]`.
6. **Stale secondary docs.**
   - The Python SDK README still targets older networks (`mendoza`, `kaolin`) and calls Arkiv "a permissioned storage system", contradicting the main docs.
   - The JS SDK README shows `^0.9.0` while npm `latest` is `1.0.1`.
   - We only trusted the API after reading the 1.0.1 tarball's source.
7. **`arkiv_query` returns an undocumented `cursor`.** A query with `count` came back with `"cursor": "b64:…"`, which the JSON-RPC docs don't mention. Is it a supported way to paginate?
8. **182-day maximum lifetime for evidence.** Reviews are meant to be durable, so we must renew them periodically. `permissionlessExtension` makes this shareable, which is good. **Would help:** a documented pattern (or a funded keeper) for "keep alive while anyone cares".

## Something we don't have yet that would make adding Arkiv easier

A **dry-run mode for writes**: given a batch, return the encoded operations, the gas estimate, the resolved expiry blocks and the predicted entity keys, without signing. It is what an application needs to show a human "this is exactly what will be written and what it costs" before they approve it, and we had to build it ourselves.

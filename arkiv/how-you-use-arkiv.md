# How Receipts uses Arkiv

## Do the filters, the edit rights and the expirations fit what the app does?

**Filters.** Every indexed column is one a consumer actually filters or sorts on:

| Question a consumer asks | Query (plus `$creator` = publisher) |
|---|---|
| What is agent N's current Receipts score? | `receipts.reputation/v1`, `agentId = str('N')`, `ORDER BY snapshotBlock DESC`, limit 1 |
| Which agents can I trust above a bar? | `status = str('published') AND score >= 70`, optionally `distinctHumans >= 10` |
| Show me agent N's reviews | `receipts.review/v1`, `agentId = str('N')`, `ORDER BY blockNumber DESC` |
| Only the paid ones | `... AND reviewType = 1` |
| Everything wallet W reviewed | `reviewer = addr(W)` |
| Is this on-chain review mirrored? | `txHash = str('0x…')` or `feedbackHash = str('0x…')` |

Columns nobody filters on (`threshold`, `totalWeight`, `logIndex`, `receiptId`, `content`) are stored but not indexed. `content` is `bytes`, which Arkiv cannot index anyway.

**Who can edit.** Both entity types are created `readonly`. A published review cannot be rewritten, including by us. That matches the chain: the gateway has no revoke path, so a review never legitimately changes. Snapshots are also readonly; a changed score is a new snapshot, not an edit of the old one. The publisher keeps ownership, so `$owner` and `$creator` both identify Receipts.

**When it expires.**
- **Reviews:** the network maximum, renewed when under 30 days remain. They are created with `permissionlessExtension`, so the reviewed agent, the reviewer or a third party can keep a review alive without being able to alter it.
- **Snapshots:** 7 days. The publisher extends an unchanged snapshot instead of writing a duplicate. A snapshot nobody renews (for example because Receipts stopped running) disappears within a week instead of advertising a stale score as current.

## Does each Arkiv feature change something users see?

| Feature | What the user sees |
|---|---|
| Query by indexed attribute | The agent page's **Public record on Arkiv** card: the latest snapshot and every mirrored review, fetched from Rabdi in the browser |
| `$creator` filter | The card shows the publisher address it trusts and ignores look-alike entities from anyone else |
| `bytes` content | Each mirrored review shows its text and a **Text matches on-chain hash** badge computed in the browser |
| `$expiresAt` | Each snapshot and review shows "expires in N days" |
| Extend | A snapshot whose expiry moves forward means "still current"; the publisher extends rather than duplicates |
| `readonly` | Visible in the explorer's creation flags; the guarantee that the record shown is the one first published |
| `permissionlessExtension` | Lets an agent keep its own review history visible; documented for agents in the README |
| `executeBatch` | Up to 10 reviews and snapshots per transaction, so publishing a backlog costs one transaction per ten entities |
| Explorer | Every entity and review in the card links to `rabdi.explorer.arkiv.network/entity/<key>` |
| Public JSON-RPC (`arkiv_query`) | The card's **copy curl** buttons give the exact query it ran, runnable with no key |

## How a publish works

`npm run arkiv:publish` ([`server/src/arkiv/cli.ts`](../server/src/arkiv/cli.ts)):

1. **Index.** Reads `ReviewSubmitted` and `NewFeedback` from Sepolia and pairs them by transaction, using the same rules as the scoring engine. It keeps only reviews 12 blocks deep, and drops the nullifier.
2. **Score.** Computes each agent's snapshot with the same retrieval, engine and manifest code as `GET /api/agents/:id/reputation`.
3. **Read back.** Reads what the publisher already wrote, filtered on `$creator`, so a rerun never publishes a review twice.
4. **Plan.** Decides what to create, extend or leave alone. Writes the plan to a file and prints every value, the publisher's tGLM balance, a gas estimate from the node (sending is blocked) and the file's hash.
5. **Execute.** Runs only with `--execute --plan <file> --confirm <hash>`. It refuses if the file was edited or a planned review is already on Arkiv.

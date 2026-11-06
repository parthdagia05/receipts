# SQLite → PostgreSQL: audit and plan

Phase 1 of Sprint 2. Written before any code changed.

The governing constraint: this database enforces the protocol's core rule.
A semantic change here is a correctness regression, not a refactor. Every
section states what must remain true, not only what must be rewritten.

---

## 1. Inventory

### 1.1 `better-sqlite3` usage

Only **one** production file imports the driver:

| File | Usage |
| --- | --- |
| `src/db/index.ts` | `import Database from 'better-sqlite3'` — the single construction site |
| `src/db/worldIdRequests.ts:194` | comment only |
| `test/concurrency.test.ts:39` | `require('better-sqlite3')` **inside an inline worker** — see §5 |
| `test/reviewAttest.test.ts:824` | comment only |

That the driver is constructed in exactly one place is the single most
helpful fact in this audit: the type `Db` is re-exported from `index.ts`, so
every other module depends on the *type*, not the package.

### 1.2 Modules, size and call sites

| Module | Lines | Exported functions |
| --- | --- | --- |
| `db/index.ts` | 54 | `openDatabase`, `isDatabaseReachable` |
| `db/migrate.ts` | 74 | `appliedMigrations`, `runMigrations` |
| `db/reviewAuthorizations.ts` | 394 | 6 |
| `db/worldIdRequests.ts` | 303 | 7 |
| `db/worldIdVerifications.ts` | 145 | 3 |
| `db/reviewContents.ts` | 91 | 2 |
| **Total** | **1,263** | **22** |

Route call sites: `reviewPrepare` 9, `reviewProof` 4, `reviewAttest` 3,
`worldId` 2, `reviewContent` 2, `health` 2 — **22 in total**.

### 1.3 Schema

| Migration | Table | Constraints and indexes |
| --- | --- | --- |
| `001` | `world_id_requests` | `nonce` PK; index on `expires_at` |
| `002` | `world_id_verifications` | `nonce` PK **FK →** `world_id_requests(nonce)`; **`UNIQUE (agent_id, nullifier)`**; index on `agent_id` |
| `003` | `review_authorizations` | `nonce` PK; index on `verification_nonce`; index on `deadline` |
| `004` | — | adds `authorized_at` to `world_id_verifications` |
| `005` | `review_contents` | `feedback_hash` PK; BLOB content; **two append-only triggers** |

All four `CREATE TABLE` statements use SQLite `STRICT`.
Column types: 20 `TEXT`, 14 `INTEGER`, 2 `BLOB`.

**`UNIQUE (agent_id, nullifier)` is the one-human-one-review rule.** Nothing
else in the server enforces it.

---

## 2. SQLite-specific syntax, and its replacement

| Construct | Where | PostgreSQL |
| --- | --- | --- |
| `STRICT` | 4 tables + `migrate.ts` | drop the keyword; PG enforces types natively, so this **gains** strictness |
| `INSERT OR IGNORE` | `reviewContents.ts` ×2 | `ON CONFLICT (feedback_hash) DO NOTHING` |
| `INSERT OR REPLACE` | `index.ts`, `005` | `ON CONFLICT … DO UPDATE` — **see §2.1** |
| `RAISE(ABORT, …)` | `005` ×2 | `plpgsql` trigger function with `RAISE EXCEPTION` |
| `PRAGMA busy_timeout` | `index.ts` | `lock_timeout` / `statement_timeout` |
| `PRAGMA journal_mode = WAL` | `index.ts` | none needed — PG is MVCC |
| `PRAGMA foreign_keys = ON` | `index.ts` | always on |
| `PRAGMA recursive_triggers = ON` | `index.ts` | not applicable — §2.1 |
| `?` placeholders | everywhere | `$1, $2, …` |
| `changes` from `.run()` | ×4 | `result.rowCount` |

### 2.1 The `recursive_triggers` subtlety

`db/index.ts` sets `PRAGMA recursive_triggers = ON` with a comment explaining
why: SQLite's `REPLACE` is a *delete-then-insert*, so without the pragma the
append-only **DELETE** trigger on `review_contents` did not fire and content
could be silently overwritten. That was a real bug, found and fixed, with a
regression test.

PostgreSQL has no `REPLACE`. `ON CONFLICT … DO UPDATE` is genuinely an
update, so it fires `BEFORE UPDATE` directly and the problem cannot arise.
**The append-only property must still be re-proved against the new statement
rather than assumed to carry over.**

### 2.2 Type mapping

| SQLite | PostgreSQL | Note |
| --- | --- | --- |
| `TEXT` | `TEXT` | — |
| `INTEGER` (unix seconds, block numbers) | **`BIGINT`** | **SQLite `INTEGER` is 64-bit; PG's is 32-bit.** Every integer column must be `BIGINT` or values silently overflow |
| `INTEGER` (0/1 flags) | `BIGINT` | kept numeric deliberately — see §6 |
| `BLOB` | `BYTEA` | — |

---

## 3. Transactions and the concurrency guarantee

Three transaction sites; two use `.immediate()`.

| Site | Mode | Purpose |
| --- | --- | --- |
| `migrate.ts:65` | default | apply one migration |
| `reviewAuthorizations.ts:148` | **`.immediate()`** | create authorization |
| `reviewAuthorizations.ts:319` | **`.immediate()`** | **consume authorization** |

### 3.1 What `BEGIN IMMEDIATE` guarantees

The comment at `reviewAuthorizations.ts:312` states the reasoning exactly:

> This transaction reads before it writes, and a deferred transaction that
> upgrades to a write while another holds the lock fails immediately with
> `SQLITE_BUSY` — a `busy_timeout` cannot rescue a snapshot upgrade.
> `BEGIN IMMEDIATE` takes the write lock up front, so a competing caller
> waits and then observes the committed state, returning a classified
> failure instead of throwing.

The consume transaction is read-then-decide-then-write:

1. read the authorization
2. if already consumed → classify as replay or conflict
3. `UPDATE … WHERE consumed_at IS NULL AND deadline > now`
4. if `changes !== 1` → re-read and reclassify
5. `UPDATE world_id_verifications SET authorized_at = …`
6. if `changes !== 1` → **roll back** so the challenge stays unspent

**The guarantee to preserve:** under concurrent callers, exactly one succeeds
and the others receive a *classified failure* — never an exception, never a
silently discarded challenge.

### 3.2 PostgreSQL equivalent

`BEGIN IMMEDIATE` has no direct equivalent.

| Approach | Behaviour | Verdict |
| --- | --- | --- |
| `READ COMMITTED` (default) | no protection for read-then-write | **Reintroduces the exact race `.immediate()` exists to prevent** |
| `SERIALIZABLE` | detects the anomaly, aborts with `40001` | Correct, but the caller must retry and **no retry logic exists**; it would turn a classified failure into an exception |
| **`SELECT … FOR UPDATE`** | takes a row lock on the initial read | **Chosen.** Maps directly onto "take the write lock before deciding", which is what the code already means, and needs no new retry machinery |

The conditional `UPDATE … WHERE consumed_at IS NULL` is itself atomic in
PostgreSQL, so step 3 is safe either way. `FOR UPDATE` on step 1 is what makes
steps 1–2 safe, and is therefore the minimal correct change.

---

## 4. Synchronous-call dependence

`better-sqlite3` is **synchronous**. Every query blocks the event loop. This
is tolerable against a local file and unacceptable against a network
database: a 5 ms round trip per query would serialise the whole process.

So `pg` is async and **all 22 functions must become `async`**, rippling
through 22 route call sites. **This is the bulk of the diff** — the SQL
changes are small by comparison.

Two code paths depend on synchrony in a way worth calling out:

- `worldIdRequests.ts:194` documents that a check-then-act is safe "because
  better-sqlite3 is synchronous and never interleaves". Under `pg` that is no
  longer true, and the safety must come from the statement rather than the
  driver. The statements are already written as conditional `UPDATE`s, so
  this holds — but it is now load-bearing rather than belt-and-braces.
- `test/reviewAttest.test.ts:824` asserts serialisation that the driver
  provided. It runs against SQLite and is unaffected.

---

## 5. `concurrency.test.ts` — it cannot pass unchanged

The brief requires it to pass unchanged, so this needs stating precisely.

**It is hard-coded to SQLite at three levels:**

| Line | Dependency |
| --- | --- |
| 6 | `import { IN_MEMORY, openDatabase } from '../src/db/index.js'` |
| 39 | `const Database = require('better-sqlite3')` — **inside an inline worker's source string** |
| 40 | `new Database(workerData.dbPath)` — constructs from a **filesystem path** |
| 145, 213, 281 | `dbPath = join(dir, 'requests.db')` — a SQLite file |
| 182 | a test whose purpose is "demonstrates the statement is what provides the guarantee", racing an unguarded `UPDATE` — SQLite-specific by construction |

A PostgreSQL database has no file path and no `better-sqlite3`. No
configuration change makes this file run against PG; it would have to be
rewritten, and rewriting the test that proves the guarantee in order to make
the migration pass is precisely the inversion to avoid.

### Minimal correction

**Keep SQLite in the repository and leave `concurrency.test.ts` byte-for-byte
untouched.** It continues to prove the SQLite guarantees it was written for,
and it continues to pass.

Add `concurrencyPg.test.ts`: a *new* file proving the *same* guarantees
against real PostgreSQL through the same repository functions —
one-winner-under-parallelism for nonce consumption, for
`UNIQUE (agent_id, nullifier)`, and for authorization consumption.

Nothing is weakened: the original assertions keep running, and the new
backend has to meet the same bar. This also satisfies the sprint rule
"keep the migration reversible until acceptance tests pass".

---

## 6. Decisions requiring explicit acknowledgement

| Decision | Choice | Why |
| --- | --- | --- |
| Isolation strategy | `SELECT … FOR UPDATE` | §3.2 |
| Boolean columns | **keep numeric 0/1 as `BIGINT`** | `BOOLEAN` is more idiomatic but changes what every read site returns. Not a silent semantic change on a migration whose rule is "preserve behaviour". Revisit separately. |
| Data migration | **a utility, not run automatically** | §7 |
| Driver coexistence | **both, during the sprint** | keeps `concurrency.test.ts` passing and the migration reversible |

---

## 7. Data migration

`server/data/receipts.db` exists and **must not be modified** — it is opened
read-only (`mode=ro`) by the utility and never written.

Migrating it is *optional* in practice: every table but one holds short-lived
state (requests and authorizations expire in 300 s), and `review_contents` is
content-addressed and rebuildable from `ReviewSubmitted` events. The utility
exists so the operation is repeatable and auditable, not because the current
file's contents are precious.

Requirements: preserve ids and relationships, insert in FK order, be
re-runnable (`ON CONFLICT DO NOTHING`), verify row counts afterwards, and
fail loudly rather than skip rows.

---

## 8. Plan

| # | Step | Verification |
| --- | --- | --- |
| 1 | Add `pg`; keep `better-sqlite3` | both install, build green |
| 2 | Async repository interface over the 22 functions | — |
| 3 | SQLite implementation wrapping the existing sync functions | **1,004 tests pass unchanged** |
| 4 | Routes take the repository; `await` at 22 call sites | 1,004 still pass |
| 5 | Port the five migrations to PostgreSQL DDL | schema reviewed by hand |
| 6 | PostgreSQL implementation, `FOR UPDATE` in consume | — |
| 7 | **PG integration + concurrency tests** | **new tests pass on real PG** |
| 8 | Data migration utility + tests | row counts verified |
| 9 | Pooling and graceful shutdown | pool drains on `SIGTERM` |

---

## 9. Behaviour that must not change

- [ ] `UNIQUE (agent_id, nullifier)` rejects a second verification
- [ ] A challenge is consumed exactly once under concurrent load
- [ ] An identical retry returns the original result, not a conflict
- [ ] A different signature for a consumed challenge is `signature_conflict`
- [ ] A losing sibling challenge rolls back and stays unspent
- [ ] `review_contents` rows cannot be updated or deleted
- [ ] Identical content reuses its row rather than erroring
- [ ] Request expiry remains exclusive at the boundary
- [ ] `/health` returns 503 when the database is unreachable
- [ ] No error message exposes a connection string

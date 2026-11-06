# SQLite → PostgreSQL

Assessment and plan for moving the Record Server's persistence from
`better-sqlite3` to RDS PostgreSQL, **preserving every existing behaviour**.

The guiding constraint: this database enforces the protocol's core rule. A
semantic change here is not a refactor, it is a correctness regression. Each
section below names what must stay true, not only what must be rewritten.

---

## 1. Why this is required, not optional

`better-sqlite3` opens a file on local disk. On Fargate:

- Task storage is ephemeral — a deploy or a task replacement discards it.
- Each task gets its own copy — two tasks, two databases.

The second point is the serious one. `002_world_id_verifications` declares:

```sql
UNIQUE (agent_id, nullifier)
```

That constraint **is** the one-human-one-review rule on the server side. Split
across two tasks it enforces nothing: the same nullifier can be spent once per
task. The on-chain `NullifierRegistry` is the backstop and would still reject
the second submission, but the server would have issued a signed attestation
for a review that cannot land — wasting the user's gas and the Record Server's
signature.

So the options are exactly two: **one task forever**, or **shared
PostgreSQL**. This document assumes the latter.

---

## 2. Inventory

Five tables across five migrations:

| Migration | Table | Notes |
| --- | --- | --- |
| `001` | `world_id_requests` | `nonce` PK, index on `expires_at` |
| `002` | `world_id_verifications` | FK → requests, **`UNIQUE (agent_id, nullifier)`**, index on agent |
| `003` | `review_authorizations` | `nonce` PK, two indexes |
| `004` | `verification_authorized_at` | column addition |
| `005` | `review_contents` | `feedback_hash` PK, **BLOB** content, two append-only triggers |

All four `CREATE TABLE` statements use SQLite `STRICT`. Column types across
migrations: 20 `TEXT`, 14 `INTEGER`, 2 `BLOB`.

---

## 3. SQLite-specific constructs, and what each becomes

### 3.1 `STRICT` tables

SQLite-only. It makes column types enforced rather than advisory. PostgreSQL
enforces types natively, so dropping the keyword **gains** strictness rather
than losing it. No behaviour change.

### 3.2 Type mapping

| SQLite | PostgreSQL | Why not the obvious choice |
| --- | --- | --- |
| `TEXT` (hex, ids) | `TEXT` | — |
| `INTEGER` (unix seconds) | `BIGINT` | `INTEGER` is 32-bit in PG; a timestamp fits but a block number may not. Use `BIGINT` uniformly. |
| `INTEGER` (booleans) | `BOOLEAN` | SQLite has no boolean; the code stores 0/1. See §3.7. |
| `BLOB` (review content) | `BYTEA` | — |

**`INTEGER` is the trap.** SQLite's `INTEGER` is up to 64-bit; PostgreSQL's is
32-bit and silently different. Every integer column must become `BIGINT`.

### 3.3 `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`

Used twice in `db/reviewContents.ts`. Direct equivalent:

```sql
-- SQLite
INSERT OR IGNORE INTO review_contents (feedback_hash, content, created_at) VALUES (?, ?, ?);
-- PostgreSQL
INSERT INTO review_contents (feedback_hash, content, created_at) VALUES ($1, $2, $3)
ON CONFLICT (feedback_hash) DO NOTHING;
```

Semantics match: a repeated submission of identical content reuses the row.

### 3.4 `INSERT OR REPLACE` → `ON CONFLICT DO UPDATE`

Used in `db/index.ts` and `005`. **Read the note in `db/index.ts` before
changing this.** `REPLACE` in SQLite is a *delete then insert*, which is why
`PRAGMA recursive_triggers = ON` is set — without it the append-only DELETE
trigger did not fire and content could be overwritten. That was a real bug,
found and fixed, with a regression test.

PostgreSQL has no `REPLACE`. `ON CONFLICT DO UPDATE` is an update, so it fires
`BEFORE UPDATE` triggers directly and the recursive-trigger problem does not
exist. The append-only property must be re-proved against the new statement,
not assumed to carry over.

### 3.5 Append-only triggers

`005` installs two triggers that `RAISE(ABORT, ...)` on UPDATE and DELETE.
PostgreSQL needs a trigger function:

```sql
CREATE OR REPLACE FUNCTION review_contents_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'review_contents is append-only: content cannot be %',
    lower(TG_OP);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER review_contents_no_update BEFORE UPDATE ON review_contents
  FOR EACH ROW EXECUTE FUNCTION review_contents_append_only();
CREATE TRIGGER review_contents_no_delete BEFORE DELETE ON review_contents
  FOR EACH ROW EXECUTE FUNCTION review_contents_append_only();
```

The existing tests assert the *message*, so either keep the wording identical
or update the assertions deliberately. Do not let them drift silently.

### 3.6 `PRAGMA` statements

| Pragma | PostgreSQL equivalent |
| --- | --- |
| `busy_timeout = 5000` | `lock_timeout` / `statement_timeout` on the connection |
| `journal_mode = WAL` | none needed — PG is MVCC by default |
| `foreign_keys = ON` | always on |
| `recursive_triggers = ON` | not applicable (§3.4) |

### 3.7 Boolean columns

The code writes `0`/`1` into `INTEGER` columns and reads them back as numbers.
Moving to `BOOLEAN` means the driver returns `true`/`false`. Every read site
must be checked. Two options:

1. Keep `BIGINT` and preserve 0/1 — least code change, least idiomatic.
2. Move to `BOOLEAN` and fix the read sites — correct, more diff.

**Recommendation: option 2**, because option 1 leaves a type that lies about
what it holds, and the read sites are few. Either way the choice must be
explicit; silently changing what `revoked` returns is exactly the kind of
"silent semantic change" the brief forbids.

---

## 4. Transaction semantics — the hard part

Three call sites use transactions, and two use `.immediate()`:

| Site | Mode | Why |
| --- | --- | --- |
| `migrate.ts:65` | default | schema application |
| `reviewAuthorizations.ts:148` | `.immediate()` | create |
| `reviewAuthorizations.ts:319` | `.immediate()` | **consume** |

The comment at `reviewAuthorizations.ts:312` explains the reasoning: these
transactions read, decide, then write, and SQLite's deferred mode takes a read
lock first and cannot upgrade it if another writer intervened —
`busy_timeout` cannot rescue a failed snapshot upgrade. `BEGIN IMMEDIATE`
takes the write lock up front.

**PostgreSQL has no `BEGIN IMMEDIATE`.** The equivalent guarantee needs one of:

| Approach | Behaviour | Verdict |
| --- | --- | --- |
| `SERIALIZABLE` isolation | detects the anomaly, aborts with `40001` | Correct, but the caller must retry, and no retry logic exists today |
| `SELECT … FOR UPDATE` | takes a row lock on read | **Closest to the current semantics**: one statement change, no retry loop |
| Default `READ COMMITTED` | **no equivalent protection** | Would reintroduce the exact race the `.immediate()` was added to prevent |

**Recommendation: `SELECT … FOR UPDATE`** in the consume path. It maps
directly onto "take the write lock before deciding", which is what the code
already means, and it needs no new retry machinery.

There is an existing concurrency test — `server/test/concurrency.test.ts`,
driving `test/workers/consumeAuthorization.worker.ts` and
`consumeVerification.worker.ts` through worker threads. **These tests are the
acceptance criteria for this section.** They must pass against PostgreSQL
unchanged. If they are rewritten to pass, the migration has not been proved.

---

## 5. Connection pooling and concurrency

`better-sqlite3` is **synchronous**. Every query blocks the event loop. This
is tolerable with a local file and fatal with a network database — a 5 ms
round trip per query would serialise the whole process.

So the driver must be async (`pg`), and every `db/*.ts` function becomes
`async`. This is the largest mechanical change in the migration: the function
bodies are straightforward, but the signatures ripple into every route.

Pool sizing:

```
max = 10 per task × 2 tasks = 20 connections
db.t4g.micro max_connections ≈ 100
```

Comfortable headroom. Set `idleTimeoutMillis` and `connectionTimeoutMillis`
explicitly; the defaults hold connections open across a deploy.

---

## 6. Migration runner

`migrate.ts` applies numbered migrations inside a transaction and records
applied names. The structure survives; what changes:

- `db.transaction(() => …)` → `pg` client with explicit `BEGIN`/`COMMIT`
- the applied-migrations table gets `STRICT` removed
- **add an advisory lock** so two tasks starting simultaneously cannot both
  apply migration `006`:

```sql
SELECT pg_advisory_lock(7265636569707473);  -- 'receipts'
```

This has no SQLite counterpart and is genuinely new work. Without it the
first deploy with two tasks is a race.

---

## 7. Data export / import

**Recommendation: do not migrate the data.** Justification:

- The only production SQLite database is a local development file.
- Every table holds short-lived state: World ID requests expire in 300s,
  authorizations in 300s, verifications are consumed.
- `review_contents` is the only durable table, and it is content-addressed —
  it can be repopulated from the chain, because every `feedbackHash` is in a
  `ReviewSubmitted` event.

If a future migration does need data movement, the shape is: `sqlite3 .dump`
→ rewrite `INSERT OR *` statements → `psql`. Hex strings and integers
transfer directly; `BLOB` needs `\x` hex encoding for `BYTEA`.

---

## 8. Plan

| # | Step | Verification |
| --- | --- | --- |
| 1 | Add `pg`, keep `better-sqlite3` | both installed, build green |
| 2 | Introduce a driver interface over the five `db/*.ts` modules | existing tests pass unchanged on SQLite |
| 3 | Make every `db/*` function async; propagate through routes | 985 tests still pass |
| 4 | Port the five migrations to PostgreSQL DDL | schema diff reviewed by hand |
| 5 | Implement the PG driver with `FOR UPDATE` in consume | — |
| 6 | **Run `concurrency.test.ts` against PG** | **passes unmodified** |
| 7 | Add advisory lock to the runner | two concurrent starts apply once |
| 8 | Point staging at RDS, run the full suite | 985 pass |
| 9 | Delete the SQLite driver | — |

Step 3 is the bulk of the diff. Step 6 is the one that decides whether the
migration is correct.

---

## 9. Behaviour that must not change

A checklist to verify against, not a summary:

- [ ] `UNIQUE (agent_id, nullifier)` still rejects a second verification
- [ ] A challenge can be consumed exactly once under concurrent load
- [ ] An identical retry returns the original result, not a conflict
- [ ] `review_contents` rows cannot be updated or deleted
- [ ] Identical content reuses its row rather than erroring
- [ ] Expiry remains exclusive at the boundary (`worldIdRequests.ts:284`)
- [ ] `/health` returns 503 when the database is unreachable
- [ ] No error message exposes a connection string

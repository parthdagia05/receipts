/**
 * The PostgreSQL schema, ported from the six SQLite migrations.
 *
 * Deliberately one file rather than six. The SQLite migrations are a
 * historical record of how that schema grew; this is the schema that growth
 * arrived at, applied once to an empty database. Replaying five steps to
 * reach a known end state would add ordering risk for no benefit.
 *
 * Differences from the SQLite original, each with a reason:
 *
 *   STRICT              dropped. PostgreSQL enforces types natively, so this
 *                       gains strictness rather than losing it.
 *   INTEGER -> BIGINT   SQLite's INTEGER is 64-bit, PostgreSQL's is 32-bit.
 *                       Unix seconds fit either, block numbers do not, and a
 *                       silent overflow is the worst possible failure here.
 *   BLOB -> BYTEA       direct equivalent.
 *   0/1 flags           kept numeric, NOT converted to BOOLEAN. Idiomatic PG
 *                       would use BOOLEAN, but that changes what every read
 *                       site returns, and this migration's rule is to
 *                       preserve behaviour. Worth revisiting separately.
 *   RAISE(ABORT)        becomes a plpgsql trigger function.
 */

/** Bumped only when this file changes in a way an existing database needs. */
export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
-- Applied-schema marker. Mirrors the role of SQLite's migrations table.
CREATE TABLE IF NOT EXISTS schema_version (
  version     BIGINT      PRIMARY KEY,
  applied_at  BIGINT      NOT NULL
);

-- 001 -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS world_id_requests (
  nonce       TEXT    PRIMARY KEY,
  rp_id       TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  agent_id    TEXT    NOT NULL,
  created_at  BIGINT  NOT NULL,
  expires_at  BIGINT  NOT NULL,
  consumed_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_world_id_requests_expires_at
  ON world_id_requests (expires_at);

-- 002 + 004 -----------------------------------------------------------------
-- UNIQUE (agent_id, nullifier) IS the one-human-one-review rule. Nothing
-- else in the server enforces it; it must survive this migration intact.
CREATE TABLE IF NOT EXISTS world_id_verifications (
  nonce         TEXT    PRIMARY KEY REFERENCES world_id_requests (nonce),
  agent_id      TEXT    NOT NULL,
  reviewer      TEXT    NOT NULL,
  nullifier     TEXT    NOT NULL,
  verified_at   BIGINT  NOT NULL,
  authorized_at BIGINT,
  UNIQUE (agent_id, nullifier)
);

CREATE INDEX IF NOT EXISTS idx_world_id_verifications_agent
  ON world_id_verifications (agent_id);

-- 003 -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_authorizations (
  nonce              TEXT    PRIMARY KEY,
  verification_nonce TEXT    NOT NULL REFERENCES world_id_verifications (nonce),
  agent_id           TEXT    NOT NULL,
  reviewer           TEXT    NOT NULL,
  nullifier          TEXT    NOT NULL,
  value              BIGINT  NOT NULL,
  value_decimals     BIGINT  NOT NULL,
  feedback_hash      TEXT    NOT NULL,
  review_type        BIGINT  NOT NULL,
  receipt_id         TEXT    NOT NULL,
  deadline           BIGINT  NOT NULL,
  created_at         BIGINT  NOT NULL,
  consumed_at        BIGINT,
  signature          TEXT
);

CREATE INDEX IF NOT EXISTS idx_review_authorizations_verification
  ON review_authorizations (verification_nonce);

CREATE INDEX IF NOT EXISTS idx_review_authorizations_deadline
  ON review_authorizations (deadline);

-- 006 -----------------------------------------------------------------------
-- Wallet-verified review challenges. A separate table because
-- review_authorizations.verification_nonce requires a World ID verification.
-- The partial unique index forbids two SPENT challenges for one
-- (agent, reviewer); unspent ones may coexist. See the SQLite migration.
CREATE TABLE IF NOT EXISTS wallet_review_authorizations (
  nonce          TEXT    PRIMARY KEY,
  agent_id       TEXT    NOT NULL,
  reviewer       TEXT    NOT NULL,
  nullifier      TEXT    NOT NULL,
  value          BIGINT  NOT NULL CHECK (value BETWEEN 0 AND 100),
  value_decimals BIGINT  NOT NULL CHECK (value_decimals = 0),
  feedback_hash  TEXT    NOT NULL,
  review_type    BIGINT  NOT NULL CHECK (review_type = 2),
  receipt_id     TEXT    NOT NULL CHECK (receipt_id = '0x0000000000000000000000000000000000000000000000000000000000000000'),
  deadline       BIGINT  NOT NULL,
  created_at     BIGINT  NOT NULL,
  consumed_at    BIGINT,
  signature      TEXT,
  CHECK ((consumed_at IS NULL) = (signature IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_review_spent
  ON wallet_review_authorizations (agent_id, reviewer)
  WHERE consumed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_review_agent_reviewer
  ON wallet_review_authorizations (agent_id, reviewer);

CREATE INDEX IF NOT EXISTS idx_wallet_review_deadline
  ON wallet_review_authorizations (deadline);

-- 005 -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_contents (
  feedback_hash TEXT   PRIMARY KEY,
  content       BYTEA  NOT NULL,
  created_at    BIGINT NOT NULL
);

-- Append-only. The SQLite original used RAISE(ABORT, ...) in two triggers.
--
-- Note what is NOT needed here: SQLite required PRAGMA recursive_triggers
-- because its REPLACE is a delete-then-insert, and without the pragma the
-- DELETE trigger did not fire. PostgreSQL has no REPLACE; ON CONFLICT DO
-- UPDATE is genuinely an update and fires BEFORE UPDATE directly, so that
-- class of bug cannot occur. The property is still tested rather than assumed.
CREATE OR REPLACE FUNCTION review_contents_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'review_contents is append-only: content cannot be %',
    CASE TG_OP WHEN 'UPDATE' THEN 'modified' ELSE 'deleted' END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS review_contents_no_update ON review_contents;
CREATE TRIGGER review_contents_no_update
  BEFORE UPDATE ON review_contents
  FOR EACH ROW EXECUTE FUNCTION review_contents_append_only();

DROP TRIGGER IF EXISTS review_contents_no_delete ON review_contents;
CREATE TRIGGER review_contents_no_delete
  BEFORE DELETE ON review_contents
  FOR EACH ROW EXECUTE FUNCTION review_contents_append_only();
`;

/**
 * Advisory lock key held while the schema is applied.
 *
 * Two server processes starting together would otherwise both run the DDL.
 * `CREATE TABLE IF NOT EXISTS` makes that mostly harmless, but "mostly" is
 * not a property to rely on during a deploy. SQLite had no equivalent because
 * it had one writer by construction.
 */
export const SCHEMA_ADVISORY_LOCK = 7265636569707473n; // 'receipts'

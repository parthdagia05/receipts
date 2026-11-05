import type { Migration } from '../migrate.js';

const ZERO_BYTES32 = `0x${'00'.repeat(32)}`;

/**
 * Wallet-verified review challenges.
 *
 * A separate table from `review_authorizations`, not an extension of it: that
 * table's `verification_nonce` is a NOT NULL foreign key to a World ID
 * verification, and a wallet review has none by definition. Making the column
 * nullable would weaken the invariant "every challenge belongs to a verified
 * human" for the paths that rely on it.
 *
 * `review_type = 2` and the zero `receipt_id` are CHECK constraints, so even a
 * bug in application code cannot store a wallet challenge that claims to be
 * human-verified or paid. `value` and `value_decimals` carry the gateway's own
 * ranges for the same reason.
 *
 * `nonce` is the primary key: a challenge id is single-use and cannot be
 * re-issued. Spending sets `consumed_at` and `signature` together (a CHECK
 * keeps them in step), which is what makes a retry of the same signature
 * idempotent and a different signature a conflict.
 *
 * One review per wallet per agent is a UNIQUE index over (agent_id, reviewer)
 * restricted to SPENT rows. It is partial on purpose: a reviewer may be issued
 * several challenges (abandoned drafts, a redraft, a lost response), and an
 * unspent one must not block the next or let a third party who merely asks for
 * a challenge lock the wallet out. What the index forbids is two challenges for
 * the same (agent, reviewer) both being spent, so the database — not the
 * application's read-then-write — settles a race. `reviewer` is stored in
 * EIP-55 form so two spellings of one address cannot both pass.
 *
 * This is wallet uniqueness only. It says nothing about the human behind the
 * wallet; one person can hold any number of wallets.
 */
export const migration006WalletReviewAuthorizations: Migration = {
  id: '006_wallet_review_authorizations',
  sql: `
    CREATE TABLE wallet_review_authorizations (
      nonce          TEXT    PRIMARY KEY,
      agent_id       TEXT    NOT NULL,
      reviewer       TEXT    NOT NULL,
      nullifier      TEXT    NOT NULL,
      value          INTEGER NOT NULL CHECK (value BETWEEN 0 AND 100),
      value_decimals INTEGER NOT NULL CHECK (value_decimals = 0),
      feedback_hash  TEXT    NOT NULL,
      review_type    INTEGER NOT NULL CHECK (review_type = 2),
      receipt_id     TEXT    NOT NULL CHECK (receipt_id = '${ZERO_BYTES32}'),
      deadline       INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      consumed_at    INTEGER,
      signature      TEXT,
      CHECK ((consumed_at IS NULL) = (signature IS NULL))
    ) STRICT;

    CREATE UNIQUE INDEX uq_wallet_review_spent
      ON wallet_review_authorizations (agent_id, reviewer)
      WHERE consumed_at IS NOT NULL;

    CREATE INDEX idx_wallet_review_agent_reviewer
      ON wallet_review_authorizations (agent_id, reviewer);

    CREATE INDEX idx_wallet_review_deadline
      ON wallet_review_authorizations (deadline);
  `,
};

import type { Migration } from '../migrate.js';

/**
 * One row per wallet-authorization challenge issued.
 *
 * The row holds the exact content the wallet was asked to sign. Submission
 * therefore carries only `(nonce, signature)`: the typed data is rebuilt from
 * here, so there is no field a client could alter after signing.
 *
 * `verification_nonce` is a foreign key, so a challenge always belongs to a
 * World ID verification this server recorded. It is not unique — a reviewer may
 * redraft their rating, producing several challenges — and only one of them can
 * ever be spent, which `world_id_verifications.authorized_at` enforces.
 *
 * `nullifier` is the bytes32 form, converted once at creation and reused by the
 * later attestation. `agent_id` is TEXT because a uint256 does not fit SQLite's
 * INTEGER; `value`, `value_decimals` and `review_type` are small by the
 * gateway's own rules.
 *
 * `signature` is stored on consume so a retried submission of the identical
 * signature can be answered from the original result rather than rejected.
 */
export const migration003ReviewAuthorizations: Migration = {
  id: '003_review_authorizations',
  sql: `
    CREATE TABLE review_authorizations (
      nonce              TEXT    PRIMARY KEY,
      verification_nonce TEXT    NOT NULL REFERENCES world_id_verifications (nonce),
      agent_id           TEXT    NOT NULL,
      reviewer           TEXT    NOT NULL,
      nullifier          TEXT    NOT NULL,
      value              INTEGER NOT NULL,
      value_decimals     INTEGER NOT NULL,
      feedback_hash      TEXT    NOT NULL,
      review_type        INTEGER NOT NULL,
      receipt_id         TEXT    NOT NULL,
      deadline           INTEGER NOT NULL,
      created_at         INTEGER NOT NULL,
      consumed_at        INTEGER,
      signature          TEXT
    ) STRICT;

    CREATE INDEX idx_review_authorizations_verification
      ON review_authorizations (verification_nonce);

    CREATE INDEX idx_review_authorizations_deadline
      ON review_authorizations (deadline);
  `,
};

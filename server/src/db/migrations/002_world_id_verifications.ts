import type { Migration } from '../migrate.js';

/**
 * One row per successfully verified World ID proof: the facts the wallet
 * authorization chunk needs, and the uniqueness the whole design rests on.
 *
 * `nonce` is the primary key and a foreign key, so a verification always refers
 * to a request this server issued, and one request can yield at most one
 * verification.
 *
 * `UNIQUE (agent_id, nullifier)` is the one-human-one-review rule, enforced by
 * SQLite rather than by a prior read. It mirrors ReviewGateway's
 * `usedNullifier[agentId][nullifier]`, so a second attempt is refused here
 * instead of reverting on-chain after the user has paid gas.
 *
 * `nullifier` holds the RP-scoped value exactly as the API returns it — a
 * decimal field element, not hex. Converting to the contract's bytes32 is the
 * attestation chunk's job; storing the returned form keeps comparisons exact.
 */
export const migration002WorldIdVerifications: Migration = {
  id: '002_world_id_verifications',
  sql: `
    CREATE TABLE world_id_verifications (
      nonce       TEXT    PRIMARY KEY REFERENCES world_id_requests (nonce),
      agent_id    TEXT    NOT NULL,
      reviewer    TEXT    NOT NULL,
      nullifier   TEXT    NOT NULL,
      verified_at INTEGER NOT NULL,
      UNIQUE (agent_id, nullifier)
    ) STRICT;

    CREATE INDEX idx_world_id_verifications_agent
      ON world_id_verifications (agent_id);
  `,
};

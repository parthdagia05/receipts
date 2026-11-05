import type { Migration } from '../migrate.js';

/**
 * Every RP request this server signs, so a later proof can be checked against
 * a request we actually issued.
 *
 * `nonce` is the primary key, which is what makes replay impossible rather than
 * merely unlikely: the uniqueness is enforced by SQLite, not by a prior read.
 *
 * `agent_id` is TEXT because a uint256 does not fit SQLite's 64-bit INTEGER.
 * It holds the canonical decimal form, the same string the action is built from.
 *
 * `consumed_at` is NULL until a proof spends the request; timestamps are Unix
 * seconds throughout, matching what the World ID SDK returns.
 */
export const migration001WorldIdRequests: Migration = {
  id: '001_world_id_requests',
  sql: `
    CREATE TABLE world_id_requests (
      nonce       TEXT    PRIMARY KEY,
      rp_id       TEXT    NOT NULL,
      action      TEXT    NOT NULL,
      agent_id    TEXT    NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      consumed_at INTEGER
    ) STRICT;

    CREATE INDEX idx_world_id_requests_expires_at
      ON world_id_requests (expires_at);
  `,
};

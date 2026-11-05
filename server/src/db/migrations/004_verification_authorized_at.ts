import type { Migration } from '../migrate.js';

/**
 * Marks a World ID verification as having produced a wallet authorization.
 *
 * Nullable and added without a default, so existing rows read as unauthorized —
 * which is correct, since none of them has been through this flow.
 *
 * This column is what makes "one authorization per verified human per agent"
 * hold even though a verification may have several challenges: consuming one
 * sets this in the same transaction, conditioned on it still being NULL, so the
 * second challenge finds nothing to update and the whole attempt rolls back.
 */
export const migration004VerificationAuthorizedAt: Migration = {
  id: '004_verification_authorized_at',
  sql: `
    ALTER TABLE world_id_verifications
      ADD COLUMN authorized_at INTEGER;
  `,
};

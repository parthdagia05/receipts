import type { Migration } from '../migrate.js';
import { migration001WorldIdRequests } from './001_world_id_requests.js';
import { migration002WorldIdVerifications } from './002_world_id_verifications.js';
import { migration003ReviewAuthorizations } from './003_review_authorizations.js';
import { migration004VerificationAuthorizedAt } from './004_verification_authorized_at.js';
import { migration005ReviewContents } from './005_review_contents.js';
import { migration006WalletReviewAuthorizations } from './006_wallet_review_authorizations.js';

/**
 * The project's migrations, in application order.
 *
 * Add an entry per change and never edit one that has shipped — the ledger keys
 * on `id`, so an edited migration is not re-applied on databases that already
 * recorded it.
 */
export const MIGRATIONS: readonly Migration[] = [
  migration001WorldIdRequests,
  migration002WorldIdVerifications,
  migration003ReviewAuthorizations,
  migration004VerificationAuthorizedAt,
  migration005ReviewContents,
  migration006WalletReviewAuthorizations,
];

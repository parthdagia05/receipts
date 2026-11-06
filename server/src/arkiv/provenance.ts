import pg from 'pg';
import type { ConfirmedReview } from './records.js';

/**
 * Which World ID environment verified a review, as far as Receipts' own
 * records show.
 *
 * Sepolia does not record this. A `human-verified` review on-chain says only
 * that the Record Server signed it, and the Record Server signs for staging
 * World ID (the Simulator) as readily as for production. So this is the
 * publisher's statement from its databases, not something a reader can check
 * against the chain, and the schema docs say so.
 *
 * - `production`: verified through an RP registered for production World ID.
 * - `staging`:    verified through a staging RP. Staging proofs come from the
 *                 World ID Simulator, never from a real credential.
 * - `none`:       a wallet-verified review; no World ID was involved.
 * - `unknown`:    no record, conflicting records, or an RP not in the map.
 *
 * Only the RP id is ever read. Nullifiers, signatures, nonces and reviewer
 * identity data stay in the database.
 */
export type WorldIdEnvironment = 'production' | 'staging' | 'none' | 'unknown';

export interface Provenance {
  readonly environment: WorldIdEnvironment;
  /** The World ID RP the verification went through, when one was found. */
  readonly rpId?: string;
}

/** Looks up the RP ids recorded for one review. One source per database. */
export type RpLookup = (review: ConfirmedReview) => Promise<readonly string[]>;

const RP_ID_PATTERN = /^rp_[0-9a-f]{16}$/;

/** Wallet-verified; the gateway's review type 2. */
const WALLET_REVIEW_TYPE = 2;

/**
 * Parse `ARKIV_RP_ENVIRONMENTS`: `rp_…:production,rp_…:staging`.
 * An RP missing from the map resolves to `unknown`, never to a guess.
 */
export function parseRpEnvironments(raw: string): ReadonlyMap<string, 'production' | 'staging'> {
  const out = new Map<string, 'production' | 'staging'>();
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')) {
    const [rpId, environment] = entry.split(':');
    if (
      rpId === undefined ||
      !RP_ID_PATTERN.test(rpId) ||
      (environment !== 'production' && environment !== 'staging')
    ) {
      throw new Error(
        'ARKIV_RP_ENVIRONMENTS: each entry must be "rp_<16 hex>:production" or ":staging"',
      );
    }
    if (out.has(rpId) && out.get(rpId) !== environment) {
      throw new Error(`ARKIV_RP_ENVIRONMENTS: ${rpId} is listed as both environments`);
    }
    out.set(rpId, environment);
  }
  return out;
}

/**
 * Resolve one review's provenance from every available source.
 *
 * Exactly one distinct RP across all sources is required. None, or more than
 * one, is `unknown`: two databases disagreeing about the same review is not
 * something to pick a winner from.
 */
export async function resolveProvenance(
  review: ConfirmedReview,
  lookups: readonly RpLookup[],
  rpEnvironments: ReadonlyMap<string, 'production' | 'staging'>,
): Promise<Provenance> {
  if (review.reviewType === WALLET_REVIEW_TYPE) return { environment: 'none' };

  const found = new Set<string>();
  for (const lookup of lookups) {
    for (const rpId of await lookup(review)) found.add(rpId);
  }
  if (found.size !== 1) return { environment: 'unknown' };

  const [rpId] = [...found] as [string];
  if (!RP_ID_PATTERN.test(rpId)) return { environment: 'unknown' };
  return { environment: rpEnvironments.get(rpId) ?? 'unknown', rpId };
}

/**
 * The one query provenance runs. It joins the review's authorization to the
 * World ID request it consumed and returns the RP id, nothing else. Matching
 * on agent, reviewer and review type as well as the hash means a review text
 * reused for another agent cannot borrow this one's provenance.
 */
export const RP_LOOKUP_SQL = `
  SELECT DISTINCT r.rp_id
    FROM review_authorizations a
    JOIN world_id_requests r ON r.nonce = a.verification_nonce
   WHERE lower(a.feedback_hash) = lower($1)
     AND a.agent_id = $2
     AND lower(a.reviewer) = lower($3)
     AND a.review_type = $4`;

/** Anything with pg's `query`; a pool in the CLI, a fake in tests. */
export interface Queryable {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: readonly { rp_id: unknown }[] }>;
}

export function postgresRpLookup(db: Queryable): RpLookup {
  return async (review) => {
    const { rows } = await db.query(RP_LOOKUP_SQL, [
      review.feedbackHash,
      review.agentId.toString(10),
      review.reviewer,
      review.reviewType,
    ]);
    return rows.map((r) => r.rp_id).filter((v): v is string => typeof v === 'string');
  };
}

/**
 * Open read-only pools for `ARKIV_PROVENANCE_DATABASE_URLS` (comma-separated).
 * Every session is set read-only, so a mistake here cannot write.
 */
export function openProvenanceDatabases(urls: readonly string[]): {
  lookups: RpLookup[];
  close: () => Promise<void>;
} {
  const pools = urls.map(
    (connectionString) =>
      new pg.Pool({
        connectionString,
        max: 1,
        options: '-c default_transaction_read_only=on',
      }),
  );
  return {
    lookups: pools.map((p) => postgresRpLookup(p)),
    close: async () => {
      await Promise.all(pools.map((p) => p.end()));
    },
  };
}

/**
 * Tally an agent's reviews for its snapshot. Wallet-verified reviews (`none`)
 * are not human-labelled and are left out.
 */
export function countProvenance(provenances: readonly Provenance[]): {
  production: number;
  staging: number;
  unknown: number;
} {
  const counts = { production: 0, staging: 0, unknown: 0 };
  for (const p of provenances) if (p.environment !== 'none') counts[p.environment] += 1;
  return counts;
}

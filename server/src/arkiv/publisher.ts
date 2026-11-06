import type { CreateEntityValues } from '@arkiv-network/sdk/schema';
import type { Hex } from 'viem';
import {
  reputationEntityValues,
  reviewEntityValues,
  reviewId,
  snapshotFingerprint,
} from './records.js';
import type { ConfirmedReview, SnapshotInput } from './records.js';
import type { ReputationSchema, ReviewSchema } from './schemas.js';

/**
 * Decide what to write to Arkiv, separately from writing it.
 *
 * The plan is a plain value so the CLI can print it in full for approval
 * (`--dry-run`, the default) and then execute exactly that plan. Planning
 * reads Arkiv and Sepolia; it never signs anything.
 *
 * Idempotent across runs. Arkiv itself is the record of what has been
 * published: before planning, the publisher's own entities are read back
 * (filtered by `$creator`, so nobody else's writes under our tag count), and
 * a review already published is not published again.
 */

/** Seconds per Rabdi block, from `arkiv_getBlockTiming`. */
export const RABDI_BLOCK_SECONDS = 2n;

/** Snapshots live a week; a newer one or an extension replaces them. */
export const SNAPSHOT_LIFETIME_DAYS = 7;
/** An unchanged snapshot is extended once less than this much life is left. */
export const SNAPSHOT_RENEW_BELOW_DAYS = 6;
/** A review entity is extended to the maximum once less than this is left. */
export const REVIEW_RENEW_BELOW_DAYS = 30;

const blocksForDays = (days: number): bigint => (BigInt(days) * 86_400n) / RABDI_BLOCK_SECONDS;

/** What the publisher has already written, as read back from Arkiv. */
export interface PublishedState {
  /** Review entities keyed by `reviewId`. */
  readonly reviews: ReadonlyMap<string, { readonly entityKey: Hex; readonly expiresAt: bigint }>;
  /** The newest snapshot per agent id (decimal). */
  readonly latestSnapshots: ReadonlyMap<
    string,
    { readonly entityKey: Hex; readonly expiresAt: bigint; readonly fingerprint: string }
  >;
}

export type PlannedCreate =
  | {
      readonly kind: 'review';
      readonly id: string;
      readonly values: CreateEntityValues<typeof ReviewSchema>;
    }
  | {
      readonly kind: 'reputation';
      readonly id: string;
      readonly values: CreateEntityValues<typeof ReputationSchema>;
    };

export interface PlannedExtension {
  readonly kind: 'review' | 'reputation';
  readonly entityKey: Hex;
  readonly reason: string;
}

export interface PublicationPlan {
  readonly creates: readonly PlannedCreate[];
  readonly extensions: readonly PlannedExtension[];
  /** Reviews and snapshots left alone, with why. Reported, never written. */
  readonly unchanged: readonly string[];
  readonly refused: readonly string[];
}

export interface PlanInput {
  readonly chainId: number;
  readonly reviews: readonly ConfirmedReview[];
  /** Content for a feedbackHash, or null when unavailable. */
  readonly contentFor: (feedbackHash: Hex) => Promise<Uint8Array | null>;
  readonly snapshots: readonly SnapshotInput[];
  readonly published: PublishedState;
  /** Current Rabdi block, to judge how much life an entity has left. */
  readonly arkivBlock: bigint;
}

export async function planPublication(input: PlanInput): Promise<PublicationPlan> {
  const creates: PlannedCreate[] = [];
  const extensions: PlannedExtension[] = [];
  const unchanged: string[] = [];
  const refused: string[] = [];

  for (const review of input.reviews) {
    const id = reviewId(review);
    const existing = input.published.reviews.get(id);
    if (existing !== undefined) {
      if (existing.expiresAt - input.arkivBlock < blocksForDays(REVIEW_RENEW_BELOW_DAYS)) {
        extensions.push({
          kind: 'review',
          entityKey: existing.entityKey,
          reason: `renew review ${id}`,
        });
      } else {
        unchanged.push(`review ${id}: already published as ${existing.entityKey}`);
      }
      continue;
    }
    try {
      const content = await input.contentFor(review.feedbackHash);
      creates.push({
        kind: 'review',
        id,
        values: reviewEntityValues(review, input.chainId, content),
      });
    } catch (err) {
      refused.push(err instanceof Error ? err.message : `review ${id}: refused`);
    }
  }

  for (const snapshot of input.snapshots) {
    const agent = snapshot.agentId.toString(10);
    const values = reputationEntityValues(snapshot);
    const fingerprint = snapshotFingerprint(values as Parameters<typeof snapshotFingerprint>[0]);
    const latest = input.published.latestSnapshots.get(agent);
    const live = latest !== undefined && latest.expiresAt > input.arkivBlock;

    if (live && latest.fingerprint === fingerprint) {
      if (latest.expiresAt - input.arkivBlock < blocksForDays(SNAPSHOT_RENEW_BELOW_DAYS)) {
        extensions.push({
          kind: 'reputation',
          entityKey: latest.entityKey,
          reason: `agent ${agent}: standing unchanged, renew snapshot`,
        });
      } else {
        unchanged.push(`agent ${agent}: standing unchanged since ${latest.entityKey}`);
      }
      continue;
    }
    creates.push({ kind: 'reputation', id: `agent ${agent}`, values });
  }

  return { creates, extensions, unchanged, refused };
}

/** Lifetimes and flags each kind is created with. Shown in the dry run. */
export const CREATE_POLICY = {
  review: {
    lifetime: 'max (7,884,000 blocks, about 182 days)',
    flags: { readonly: true, permissionlessExtension: true },
  },
  reputation: {
    lifetime: `${SNAPSHOT_LIFETIME_DAYS} days`,
    flags: { readonly: true, permissionlessExtension: false },
  },
} as const;

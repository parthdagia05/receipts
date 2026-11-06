import { addr, bytes, defineSchema, i32, str, u64 } from '@arkiv-network/sdk/schema';

/**
 * The two kinds of entity Receipts publishes to Arkiv.
 *
 * Arkiv is a public, queryable copy of what Receipts has already established:
 * PostgreSQL and the Sepolia contracts stay the source of truth, and nothing
 * here is read back into a score. What Arkiv adds is that another application
 * can ask "which agents score at least 70 with five or more humans" or "every
 * paid review of agent 42" without our server being up and without an
 * archive node to replay gateway logs.
 *
 * Public by construction. Every column is something that is already public on
 * Sepolia or at `/reviews/:feedbackHash`. World ID nullifiers, signatures,
 * authorization nonces and verification records never appear: the indexer
 * drops the nullifier at the boundary, and `test/arkivRecords.test.ts` fails
 * if any column is named after one of them.
 *
 * Anyone can write an entity under any schema tag, so the tag alone proves
 * nothing. Every read must also filter on `$creator` = the Receipts publisher
 * address; the frontend and the documented queries all do.
 *
 * The web app keeps a copy of these definitions in `web/src/lib/arkiv.ts`.
 * The names and column types are a published interface: change them only by
 * bumping the `/vN` suffix, never in place.
 */

export const REVIEW_SCHEMA_NAME = 'receipts.review/v1';
export const REPUTATION_SCHEMA_NAME = 'receipts.reputation/v1';

/**
 * One Receipts review, published once its `ReviewSubmitted` transaction is
 * confirmed on Sepolia.
 *
 * Created `readonly`: the gateway has no revoke path, so a published review
 * never needs to change, and the publisher cannot quietly rewrite one later.
 * Created with `permissionlessExtension`: the agent, the reviewer or anyone
 * else may keep it alive past our own renewals without being able to edit it.
 */
export const ReviewSchema = defineSchema(REVIEW_SCHEMA_NAME, {
  /** ERC-8004 agent id, decimal. A string so it can be matched exactly with
   *  `agentId = str('42')` and never overflows a numeric column. */
  agentId: str().indexed(),
  chainId: u64().indexed(),
  /** The ReviewGateway that emitted the review. */
  gateway: addr().indexed(),
  reviewer: addr().indexed(),
  /** 0 human-verified, 1 human-verified and paid, 2 wallet-verified. */
  reviewType: i32().indexed(),
  /** The ERC-8004 tag2 the gateway wrote: `human-verified`, `receipt-verified`
   *  or `wallet-verified`. */
  tag: str().indexed(),
  /** Rating, 0..100. */
  value: i32().indexed(),
  valueDecimals: i32(),
  /** ERC-8004 feedback index, per (agent, gateway). */
  feedbackIndex: u64().indexed(),
  /** keccak256 of `content`. Also signed on-chain, so the two can be checked
   *  against each other without trusting this entity. */
  feedbackHash: str().indexed(),
  /** Settled payment receipt for a paid review; absent otherwise. */
  receiptId: str().optional(),
  txHash: str().indexed(),
  logIndex: i32(),
  blockNumber: u64().indexed(),
  /** The review text exactly as hashed. Absent when the publisher could not
   *  obtain bytes that hash to `feedbackHash`. */
  content: bytes().optional(),
  contentType: str().default('text/plain; charset=utf-8'),
});

/**
 * One reputation snapshot for one agent, as `GET /api/agents/:id/reputation`
 * computed it at `snapshotBlock`.
 *
 * Short-lived on purpose: a snapshot is a statement about one block, and the
 * newest is the one that matters. Superseded snapshots expire on their own
 * instead of needing a delete. An unchanged score is renewed by extending the
 * existing entity, so `$expiresAt` moving forward means "still current".
 */
export const ReputationSchema = defineSchema(REPUTATION_SCHEMA_NAME, {
  agentId: str().indexed(),
  chainId: u64().indexed(),
  /** The scoring ruleset, e.g. `receipts-reputation/1.1`. */
  spec: str().indexed(),
  /** `published`, `below_threshold` or `no_eligible_reviews`. */
  status: str().indexed(),
  /** Weighted median, 0..100. Absent until the threshold is met. */
  score: i32().indexed().optional(),
  distinctHumans: i32().indexed(),
  threshold: i32(),
  humanVerifiedCount: i32(),
  receiptVerifiedCount: i32(),
  /** Paid-only tier: its own score and status. */
  receiptScore: i32().optional(),
  receiptStatus: str(),
  /** Wallet-verified reviews counted. Informational; never part of `score`. */
  walletCount: i32(),
  /** Sum of weights, millionths, decimal. */
  totalWeight: str(),
  unattributableCount: i32(),
  snapshotBlock: u64().indexed(),
  /** keccak256 of the canonical evidence manifest the API serves for the same
   *  block; recompute it to check this snapshot against the chain. */
  manifestHash: str().indexed(),
  reviewGateway: addr(),
});

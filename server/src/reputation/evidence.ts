import { keccak256, toBytes } from 'viem';
import type { Address, Hex } from 'viem';
import { SPEC_VERSION, formatWeight } from './spec.js';
import type { ReputationResult, ScoredTier } from './engine.js';

/**
 * The evidence manifest.
 *
 * A published score is only as good as someone else's ability to recompute
 * it, so every input that went into it is recorded: the snapshot block, the
 * contracts read, each eligible review with its weight, and each exclusion
 * with its reason. Given this document and an archive node, a third party can
 * rerun the calculation and get the same number or prove it wrong.
 *
 * The manifest is serialised canonically and hashed with keccak256. Canonical
 * means: object keys sorted, no insignificant whitespace, every integer a
 * decimal string. JSON.stringify alone is not canonical: it preserves
 * insertion order, so two runs that agree on content could otherwise
 * disagree on hash.
 *
 * Reorg and finality policy. `snapshotBlock` is the block every read in the
 * manifest was pinned to, and it is NOT asserted to be final. A manifest is a
 * statement about one block, not a promise that the block survives. Two
 * consequences a consumer must handle:
 *
 *   - A manifest whose snapshot block was reorged out describes a history
 *     that no longer exists. The block number is recorded precisely so a
 *     consumer can check it against a finalized head before relying on it.
 *   - Recomputing at a later block legitimately yields a different hash.
 *     A hash mismatch across two different snapshot blocks is not evidence
 *     of tampering.
 *
 * Manifest versions. `spec` names the ruleset. v1.1 added the per-tier
 * `tiers` section and the informational `wallet` section, and changed `spec`
 * itself, so a v1.1 hash differs from the v1.0 hash of the same chain state BY
 * DESIGN. A verifier must compare hashes only within one `spec` value; a
 * mismatch across versions is not evidence of tampering. The legacy top-level
 * fields keep their v1.0 names and meanings.
 *
 * Wallet-verified (type 2) records appear under `wallet` as informational
 * records. They are listed so a verifier can see them, and they play no part
 * in `score`, `distinctHumans`, `totalWeight` or any threshold.
 *
 * The retrieval layer accepts a confirmation lag for callers that would
 * rather trade freshness for a snapshot unlikely to be reorged.
 */

export interface EvidenceContracts {
  readonly reviewGateway: Address;
  readonly receiptSettler: Address;
  readonly identityRegistry: Address;
  readonly reputationRegistry: Address;
  /**
   * Every gateway scanned, when more than one was. `reviewGateway` stays the
   * primary (current) one; this lists the full history so a replacement
   * gateway is visible in the manifest rather than silently dropped.
   */
  readonly reviewGateways?: readonly Address[];
}

export interface EvidenceTier {
  readonly score: string | null;
  readonly status: string;
  readonly count: number;
  readonly threshold: number;
  readonly totalWeight: string;
}

export interface EvidenceManifest {
  readonly spec: string;
  readonly agentId: string;
  readonly chainId: number;
  readonly snapshotBlock: string;
  readonly contracts: EvidenceContracts;
  readonly status: ReputationResult['status'];
  readonly score: string | null;
  readonly threshold: number;
  readonly distinctHumans: number;
  readonly humanVerifiedCount: number;
  readonly receiptVerifiedCount: number;
  readonly totalWeight: string;
  readonly eligible: readonly {
    readonly nullifier: string;
    readonly value: string;
    readonly reviewType: number;
    readonly weight: string;
    readonly weightDecimal: string;
    readonly feedbackIndex: string;
    readonly gateway?: string;
  }[];
  readonly tiers: { readonly human: EvidenceTier; readonly receipt: EvidenceTier };
  /** Informational only; never part of any score. */
  readonly wallet: {
    readonly count: number;
    readonly threshold: number;
    readonly status: 'informational';
    readonly records: readonly {
      readonly nullifier: string;
      readonly value: string;
      readonly feedbackIndex: string;
      readonly gateway?: string;
    }[];
    readonly excluded: readonly {
      readonly nullifier: string;
      readonly feedbackIndex: string;
      readonly reason: string;
    }[];
  };
  readonly excluded: readonly {
    readonly nullifier: string;
    readonly feedbackIndex: string;
    readonly reason: string;
  }[];
  /**
   * On-chain records the retrieval layer could not attribute to a review.
   *
   * Part of the hashed manifest, not a side note. A score computed while
   * three feedback entries were unmatchable is a different claim from one
   * computed with none, and a verifier must see the difference without
   * having to rescan the chain themselves.
   */
  readonly unattributable: readonly { readonly detail: string }[];
}

/**
 * Serialise to canonical JSON.
 *
 * Keys are emitted in sorted order at every level, arrays keep their order
 * (the engine already sorts them deterministically), and there is no
 * whitespace. Only JSON scalars appear — bigints are converted to decimal
 * strings before they reach here, because JSON has no integer wide enough for
 * a uint256 and a float would silently lose precision.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    if (!Number.isInteger(value)) throw new Error('canonicalJson: non-integer number');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') {
    throw new Error('canonicalJson: bigint must be stringified before serialisation');
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

function evidenceTier(tier: ScoredTier): EvidenceTier {
  return {
    score: tier.score === null ? null : tier.score.toString(10),
    status: tier.status,
    count: tier.count,
    threshold: tier.threshold,
    totalWeight: tier.totalWeight.toString(10),
  };
}

export function buildManifest(input: {
  readonly agentId: bigint;
  readonly chainId: number;
  readonly snapshotBlock: bigint;
  readonly contracts: EvidenceContracts;
  readonly result: ReputationResult;
  readonly unattributable?: readonly { readonly detail: string }[];
}): EvidenceManifest {
  const { result } = input;
  return {
    spec: SPEC_VERSION,
    agentId: input.agentId.toString(10),
    chainId: input.chainId,
    snapshotBlock: input.snapshotBlock.toString(10),
    contracts: input.contracts,
    status: result.status,
    score: result.score === null ? null : result.score.toString(10),
    threshold: result.threshold,
    distinctHumans: result.distinctHumans,
    humanVerifiedCount: result.humanVerifiedCount,
    receiptVerifiedCount: result.receiptVerifiedCount,
    totalWeight: result.totalWeight.toString(10),
    eligible: result.eligible.map((entry) => ({
      nullifier: entry.nullifier,
      value: entry.value.toString(10),
      reviewType: entry.reviewType,
      weight: entry.weight.toString(10),
      weightDecimal: formatWeight(entry.weight),
      feedbackIndex: entry.feedbackIndex.toString(10),
      ...(entry.gateway === undefined ? {} : { gateway: entry.gateway }),
    })),
    tiers: {
      human: evidenceTier(result.tiers.human),
      receipt: evidenceTier(result.tiers.receipt),
    },
    wallet: {
      count: result.tiers.wallet.count,
      threshold: result.tiers.wallet.threshold,
      status: result.tiers.wallet.status,
      records: result.tiers.wallet.records.map((r) => ({
        nullifier: r.nullifier,
        value: r.value.toString(10),
        feedbackIndex: r.feedbackIndex.toString(10),
        ...(r.gateway === undefined ? {} : { gateway: r.gateway }),
      })),
      excluded: result.tiers.wallet.excluded.map((r) => ({
        nullifier: r.nullifier,
        feedbackIndex: r.feedbackIndex.toString(10),
        reason: r.reason,
      })),
    },
    excluded: result.excluded.map((entry) => ({
      nullifier: entry.nullifier,
      feedbackIndex: entry.feedbackIndex.toString(10),
      reason: entry.reason,
    })),
    // Sorted so the hash does not depend on the order the scanner happened
    // to encounter the problems in.
    unattributable: [...(input.unattributable ?? [])]
      .map((entry) => ({ detail: entry.detail }))
      .sort((a, b) => (a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0)),
  };
}

/** keccak256 over the canonical serialisation, as a 0x-prefixed hex digest. */
export function manifestHash(manifest: EvidenceManifest): Hex {
  return keccak256(toBytes(canonicalJson(manifest)));
}

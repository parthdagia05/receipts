import type { PublicClient } from 'viem';
import { computeReputation } from '../reputation/engine.js';
import { buildManifest, manifestHash } from '../reputation/evidence.js';
import type { EvidenceContracts } from '../reputation/evidence.js';
import { retrieveReviews } from '../reputation/retrieval.js';
import type { GatewaySource } from '../reputation/retrieval.js';
import { SPEC_VERSION } from '../reputation/spec.js';
import type { SnapshotInput } from './records.js';

export interface SnapshotDeps {
  readonly client: PublicClient;
  readonly chainId: number;
  readonly contracts: EvidenceContracts;
  readonly gatewayDeployBlock: bigint;
  readonly additionalGateways: readonly GatewaySource[];
  readonly confirmations: bigint;
}

/**
 * Score one agent exactly as `GET /api/agents/:agentId/reputation` does.
 *
 * Same retrieval, same engine, same manifest, so `manifestHash` here equals
 * the API's `evidence_hash` for the same snapshot block. Only the summary and
 * the hash leave this function; the manifest, which lists nullifiers, does not.
 */
export async function computeSnapshot(
  deps: SnapshotDeps,
  agentId: bigint,
): Promise<Omit<SnapshotInput, 'provenance'>> {
  const retrieved = await retrieveReviews(
    {
      client: deps.client,
      reviewGateway: deps.contracts.reviewGateway,
      receiptSettler: deps.contracts.receiptSettler,
      reputationRegistry: deps.contracts.reputationRegistry,
      fromBlock: deps.gatewayDeployBlock,
      ...(deps.additionalGateways.length === 0 ? {} : { gateways: deps.additionalGateways }),
      confirmations: deps.confirmations,
    },
    agentId,
  );
  const result = computeReputation(retrieved.reviews);
  const manifest = buildManifest({
    agentId,
    chainId: deps.chainId,
    snapshotBlock: retrieved.snapshotBlock,
    contracts:
      deps.additionalGateways.length === 0
        ? deps.contracts
        : {
            ...deps.contracts,
            reviewGateways: [
              deps.contracts.reviewGateway,
              ...deps.additionalGateways.map((g) => g.address),
            ],
          },
    result,
    unattributable: retrieved.unattributable,
  });
  return {
    agentId,
    chainId: deps.chainId,
    spec: SPEC_VERSION,
    snapshotBlock: retrieved.snapshotBlock,
    manifestHash: manifestHash(manifest),
    reviewGateway: deps.contracts.reviewGateway,
    result,
    unattributableCount: retrieved.unattributable.length,
  };
}

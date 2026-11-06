import { Hono } from 'hono';
import type { Address, PublicClient } from 'viem';
import { computeReputation } from '../reputation/engine.js';
import { buildManifest, manifestHash } from '../reputation/evidence.js';
import { retrieveReviews } from '../reputation/retrieval.js';
import type { GatewaySource } from '../reputation/retrieval.js';
import type { ReputationTiers } from '../reputation/engine.js';
import type { EvidenceContracts } from '../reputation/evidence.js';

export interface ReputationDeps {
  readonly client: PublicClient;
  readonly chainId: number;
  readonly contracts: EvidenceContracts;
  /** The gateway's deployment block; nothing earlier can hold its events. */
  readonly gatewayDeployBlock: bigint;
  /**
   * Earlier (or later) gateways whose reviews still count, each with its own
   * deployment block. A replacement gateway must not erase history.
   */
  readonly additionalGateways?: readonly GatewaySource[];
  /**
   * Blocks to stay behind the head when pinning the snapshot.
   *
   * Not cosmetic. Public RPC endpoints are load-balanced pools whose nodes
   * are not always on the same block, so reading the head from one request
   * and then querying logs up to that block on the next produced
   * "block range extends beyond current head block" for roughly five calls
   * in six. Staying a couple of blocks back makes the snapshot one that
   * every node in the pool already has, and it is also the reorg policy
   * described in evidence.ts, which was documented but never switched on.
   */
  readonly confirmations?: bigint;
}

const MAX_AGENT_ID_DIGITS = 78;

/** Wire form of the tiers. Scores are small integers; weights are strings. */
export function serializeTiers(tiers: ReputationTiers): {
  human: Record<string, unknown>;
  receipt: Record<string, unknown>;
  wallet: Record<string, unknown>;
} {
  const scored = (t: ReputationTiers['human']): Record<string, unknown> => ({
    score: t.score === null ? null : Number(t.score),
    count: t.count,
    threshold: t.threshold,
    status: t.status,
    totalWeight: t.totalWeight.toString(10),
  });
  return {
    human: scored(tiers.human),
    receipt: scored(tiers.receipt),
    wallet: {
      score: null,
      count: tiers.wallet.count,
      threshold: tiers.wallet.threshold,
      status: tiers.wallet.status,
      totalWeight: tiers.wallet.totalWeight.toString(10),
    },
  };
}

/**
 * `GET /api/agents/:agentId/reputation` — the Receipts score and its evidence.
 *
 * Reproducible by construction: the response names the snapshot block, every
 * contract that was read, each eligible review with its weight, and every
 * exclusion with a reason. Anyone with an archive node can recompute the
 * number from this document and the published engine.
 *
 * Nothing in the request influences the result beyond which agent to score.
 * Weights and review types are derived from on-chain data inside the
 * retrieval layer; a caller cannot assert that its review was receipt-verified
 * or hand the server an amount.
 */
export function reputationRoute(deps: ReputationDeps): Hono {
  const app = new Hono();

  app.get('/api/agents/:agentId/reputation', async (c) => {
    const raw = c.req.param('agentId');
    if (!/^[0-9]+$/.test(raw) || raw.length > MAX_AGENT_ID_DIGITS || /^0./.test(raw)) {
      return c.json({ error: 'invalid_agent_id' }, 400);
    }
    const agentId = BigInt(raw);
    if (agentId === 0n) return c.json({ error: 'invalid_agent_id' }, 400);

    let retrieved;
    try {
      retrieved = await retrieveReviews(
        {
          client: deps.client,
          reviewGateway: deps.contracts.reviewGateway,
          receiptSettler: deps.contracts.receiptSettler,
          reputationRegistry: deps.contracts.reputationRegistry,
          fromBlock: deps.gatewayDeployBlock,
          ...(deps.additionalGateways === undefined ? {} : { gateways: deps.additionalGateways }),
          ...(deps.confirmations === undefined ? {} : { confirmations: deps.confirmations }),
        },
        agentId,
      );
    } catch (err) {
      // A partial read would produce a score missing reviews it should
      // include, which is worse than no score. The detail can name the RPC
      // endpoint, so it is not relayed TO THE CLIENT.
      //
      // It is logged server-side, though: only the error's name and HTTP
      // status, never its message, which carries the URL and its API key.
      // Without this a failing RPC endpoint is indistinguishable from an
      // agent with no reviews, and the 503s are undiagnosable from outside.
      const name = err instanceof Error ? err.name : 'unknown';
      const status =
        typeof err === 'object' && err !== null && 'status' in err
          ? String((err as { status: unknown }).status)
          : '';
      console.error(
        `[reputation] chain read failed for agent ${agentId}: ${name}${status ? ` (status ${status})` : ''}`,
      );
      return c.json({ error: 'chain_read_failed' }, 503);
    }

    const result = computeReputation(retrieved.reviews);
    const manifest = buildManifest({
      agentId,
      chainId: deps.chainId,
      snapshotBlock: retrieved.snapshotBlock,
      contracts:
        deps.additionalGateways === undefined || deps.additionalGateways.length === 0
          ? deps.contracts
          : {
              ...deps.contracts,
              reviewGateways: [
                deps.contracts.reviewGateway,
                ...deps.additionalGateways.map((g) => g.address),
              ],
            },
      result,
      // Hashed with the rest: a score computed while records were
      // unattributable is a weaker claim than one computed with none.
      unattributable: retrieved.unattributable,
    });

    return c.json(
      {
        agent_id: raw,
        status: result.status,
        score: result.score === null ? null : Number(result.score),
        threshold: result.threshold,
        distinct_humans: result.distinctHumans,
        human_verified: result.humanVerifiedCount,
        receipt_verified: result.receiptVerifiedCount,
        total_weight: result.totalWeight.toString(10),
        snapshot_block: retrieved.snapshotBlock.toString(10),
        evidence_hash: manifestHash(manifest),
        evidence: manifest,
        unattributable: manifest.unattributable,
        // Additive. `human` equals the legacy fields above; `receipt` is the
        // paid subset of it (the categories overlap); `wallet` is
        // informational and never feeds `score`.
        tiers: serializeTiers(result.tiers),
      },
      200,
    );
  });

  return app;
}

/** Narrow re-export so `app.ts` does not need to import viem types. */
export type { Address };

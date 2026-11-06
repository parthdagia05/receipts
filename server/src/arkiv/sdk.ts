import { createWalletClient, ExpirationTime } from '@arkiv-network/sdk';
import type { PublicArkivClient, WalletArkivClient } from '@arkiv-network/sdk';
import { desc } from '@arkiv-network/sdk/query';
import { custom, http } from 'viem';
import type { Address, Hex } from 'viem';
import { CREATE_POLICY, SNAPSHOT_LIFETIME_DAYS } from './publisher.js';
import type { PublicationPlan, PublishedState } from './publisher.js';
import { snapshotFingerprint } from './records.js';
import { ReputationSchema, ReviewSchema } from './schemas.js';

/** The node's page size cap. */
const PAGE = 100;
/** Stop reading back after this many entities; far beyond a hackathon's volume. */
const MAX_ROWS = 10_000;

/**
 * Read back everything this publisher has written.
 *
 * Filtered by `$creator`, never by tag alone: anyone may create entities
 * under `receipts.review/v1`, and those must not be mistaken for ours.
 */
export async function readPublishedState(
  client: PublicArkivClient,
  publisher: Address,
): Promise<PublishedState> {
  const reviews = new Map<string, { entityKey: Hex; expiresAt: bigint }>();
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const page = await client
      .select({ $key: true, $expiresAt: true, txHash: true, logIndex: true })
      .from(ReviewSchema)
      .createdBy(publisher)
      .limit(PAGE)
      .offset(offset)
      .fetch();
    for (const row of page.entities) {
      reviews.set(`${row.txHash.value.toLowerCase()}:${row.logIndex.value}`, {
        entityKey: row.$key,
        expiresAt: row.$expiresAt,
      });
    }
    if (page.entities.length + page.skipped < PAGE) break;
  }

  const latestSnapshots = new Map<
    string,
    { entityKey: Hex; expiresAt: bigint; fingerprint: string }
  >();
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const page = await client
      .select({
        $key: true,
        $expiresAt: true,
        agentId: true,
        spec: true,
        status: true,
        score: true,
        distinctHumans: true,
        humanVerifiedCount: true,
        receiptVerifiedCount: true,
        receiptScore: true,
        walletCount: true,
        totalWeight: true,
        unattributableCount: true,
        productionVerifiedCount: true,
        stagingVerifiedCount: true,
        unknownProvenanceCount: true,
      })
      .from(ReputationSchema)
      .createdBy(publisher)
      .orderBy(desc('snapshotBlock'))
      .limit(PAGE)
      .offset(offset)
      .fetch();
    for (const row of page.entities) {
      const agent = row.agentId.value;
      // Newest first, so the first row seen per agent is its latest.
      if (latestSnapshots.has(agent)) continue;
      latestSnapshots.set(agent, {
        entityKey: row.$key,
        expiresAt: row.$expiresAt,
        fingerprint: snapshotFingerprint({
          spec: row.spec.value,
          status: row.status.value,
          score: row.score?.value,
          distinctHumans: row.distinctHumans.value,
          humanVerifiedCount: row.humanVerifiedCount.value,
          receiptVerifiedCount: row.receiptVerifiedCount.value,
          receiptScore: row.receiptScore?.value,
          walletCount: row.walletCount.value,
          totalWeight: row.totalWeight.value,
          unattributableCount: row.unattributableCount.value,
          productionVerifiedCount: row.productionVerifiedCount.value,
          stagingVerifiedCount: row.stagingVerifiedCount.value,
          unknownProvenanceCount: row.unknownProvenanceCount.value,
        }),
      });
    }
    if (page.entities.length + page.skipped < PAGE) break;
  }

  return { reviews, latestSnapshots };
}

/** Methods that would send something. The estimating transport refuses them. */
const SENDING_METHODS = new Set([
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_sign',
  'eth_signTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
]);

class DryRunStop extends Error {}

export interface PlanEstimate {
  readonly batches: number;
  /** Gas per batch as the node estimated it, or null where it would not. */
  readonly gas: readonly (bigint | null)[];
  readonly gasPrice: bigint;
  /** Sum of estimated gas times the current gas price, in wei of tGLM. */
  readonly cost: bigint | null;
}

/**
 * Ask the node what a plan would cost, without being able to send it.
 *
 * Runs the SDK's real `executeBatch` against a transport that forwards reads
 * (block number, gas estimate) to the node and throws on every method that
 * would sign or send, so the most this can do is estimate. Needs no key: the
 * account is the publisher's address as a JSON-RPC account.
 */
export async function estimatePlan(
  chain: Parameters<typeof createWalletClient>[0]['chain'],
  rpcUrl: string,
  publisher: Address,
  plan: PublicationPlan,
  batchSize = 10,
): Promise<PlanEstimate> {
  const upstream = http(rpcUrl)({ chain, retryCount: 0 });
  let lastEstimate: bigint | null = null;
  const guarded = custom({
    async request({ method, params }) {
      if (SENDING_METHODS.has(method)) throw new DryRunStop();
      const result = await upstream.request({ method, params } as never);
      if (method === 'eth_estimateGas') lastEstimate = BigInt(result as string);
      return result;
    },
  });
  const wallet = createWalletClient({ chain, transport: guarded, account: publisher });
  const gasPrice = BigInt((await upstream.request({ method: 'eth_gasPrice' } as never)) as string);

  const gas: (bigint | null)[] = [];
  for (const batch of chunkPlan(plan, batchSize)) {
    lastEstimate = null;
    try {
      await sendBatch(wallet, batch);
    } catch {
      // Expected: the send is refused once the estimate is in. Anything that
      // failed before estimating leaves `lastEstimate` null.
    }
    gas.push(lastEstimate);
  }
  const cost = gas.every((g) => g !== null)
    ? gas.reduce<bigint>((sum, g) => sum + (g ?? 0n), 0n) * gasPrice
    : null;
  return { batches: gas.length, gas, gasPrice, cost };
}

export interface ExecutedBatch {
  readonly txHash: Hex;
  readonly created: readonly { readonly id: string; readonly entityKey: Hex }[];
  readonly extended: readonly Hex[];
}

/**
 * Split a plan into the batches it is sent in: creates first, then
 * extensions, at most `batchSize` operations per transaction. Shared by
 * execution and estimation so the two always agree on what a batch is.
 */
export function chunkPlan(plan: PublicationPlan, batchSize = 10): PublicationPlan[] {
  type Op =
    | { op: 'create'; item: PublicationPlan['creates'][number] }
    | { op: 'extend'; item: PublicationPlan['extensions'][number] };
  const ops: Op[] = [
    ...plan.creates.map((item) => ({ op: 'create' as const, item })),
    ...plan.extensions.map((item) => ({ op: 'extend' as const, item })),
  ];
  const chunks: PublicationPlan[] = [];
  for (let i = 0; i < ops.length; i += batchSize) {
    const chunk = ops.slice(i, i + batchSize);
    chunks.push({
      creates: chunk.flatMap((o) => (o.op === 'create' ? [o.item] : [])),
      extensions: chunk.flatMap((o) => (o.op === 'extend' ? [o.item] : [])),
      unchanged: [],
      refused: [],
    });
  }
  return chunks;
}

/** Send one batch as one Arkiv transaction. */
async function sendBatch(
  client: WalletArkivClient,
  batch: PublicationPlan,
): Promise<ExecutedBatch> {
  const { txHash, createdEntities } = await client.executeBatch({
    // Each create names its own schema; the batch type cannot infer a mixed
    // tuple from a mapped array, so it is asserted. The SDK still checks every
    // value against its schema at runtime before anything is sent.
    creates: batch.creates.map((c) =>
      c.kind === 'review'
        ? {
            schema: ReviewSchema,
            values: c.values,
            expiration: ExpirationTime.max(),
            flags: CREATE_POLICY.review.flags,
          }
        : {
            schema: ReputationSchema,
            values: c.values,
            expiration: ExpirationTime.fromDays(SNAPSHOT_LIFETIME_DAYS),
            flags: CREATE_POLICY.reputation.flags,
          },
    ) as never,
    extensions: batch.extensions.map((e) => ({
      entityKey: e.entityKey,
      expiration:
        e.kind === 'review'
          ? ExpirationTime.max()
          : ExpirationTime.fromDays(SNAPSHOT_LIFETIME_DAYS),
    })),
  });
  return {
    txHash,
    created: batch.creates.map((c, index) => ({
      id: c.id,
      entityKey: createdEntities[index] as Hex,
    })),
    extended: batch.extensions.map((e) => e.entityKey),
  };
}

/**
 * Write a plan, one transaction per batch.
 *
 * Each batch lands atomically. A failure stops the run; the next run reads
 * back what did land and plans only the rest.
 */
export async function executePlan(
  client: WalletArkivClient,
  plan: PublicationPlan,
  batchSize = 10,
): Promise<ExecutedBatch[]> {
  const results: ExecutedBatch[] = [];
  for (const batch of chunkPlan(plan, batchSize)) results.push(await sendBatch(client, batch));
  return results;
}

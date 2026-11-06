import { createWalletClient } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { describe, expect, it } from 'vitest';
import { custom, keccak256, toBytes } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { indexConfirmedReviews } from '../src/arkiv/indexer.js';
import type { Provenance } from '../src/arkiv/provenance.js';
import {
  assertSeparateFromSigner,
  checkApprovedPlan,
  fromPlanFile,
  PlanApprovalError,
  planFileHash,
  toPlanFile,
} from '../src/arkiv/planFile.js';
import { CREATE_POLICY, planPublication, RABDI_BLOCK_SECONDS } from '../src/arkiv/publisher.js';
import type { PublishedState } from '../src/arkiv/publisher.js';
import {
  reputationEntityValues,
  reviewEntityValues,
  reviewId,
  snapshotFingerprint,
  verifiedContent,
} from '../src/arkiv/records.js';
import type { ConfirmedReview, SnapshotInput } from '../src/arkiv/records.js';
import { ReputationSchema, ReviewSchema } from '../src/arkiv/schemas.js';
import { chunkPlan, executePlan } from '../src/arkiv/sdk.js';
import { computeReputation } from '../src/reputation/engine.js';
import type { ReviewInput } from '../src/reputation/engine.js';

/**
 * Arkiv publication, with no network.
 *
 * The properties that matter: nothing private reaches an entity, only
 * confirmed and well-formed reviews are published, a run never publishes the
 * same review twice, and what executes is exactly the approved plan.
 */

const GATEWAY = '0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD' as Address;
const REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713' as Address;
const REVIEWER = '0x1111111111111111111111111111111111111111' as Address;
const NULLIFIER = `0x${'ab'.repeat(32)}` as Hex;
const ZERO32 = `0x${'00'.repeat(32)}` as Hex;
const CONTENT = toBytes('Fast, correct, and paid out on time.');
const CONTENT_HASH = keccak256(CONTENT);

const txHash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

function review(overrides: Partial<ConfirmedReview> = {}): ConfirmedReview {
  return {
    agentId: 42n,
    gateway: GATEWAY,
    reviewer: REVIEWER,
    reviewType: 0,
    tag: 'human-verified',
    value: 87n,
    valueDecimals: 0,
    feedbackIndex: 1n,
    feedbackHash: CONTENT_HASH,
    receiptId: ZERO32,
    txHash: txHash(1),
    logIndex: 3,
    blockNumber: 12_070_000n,
    ...overrides,
  };
}

function snapshot(result = computeReputation([])): SnapshotInput {
  return {
    agentId: 42n,
    chainId: 11155111,
    spec: 'receipts-reputation/1.1',
    snapshotBlock: 12_070_100n,
    manifestHash: `0x${'cd'.repeat(32)}`,
    reviewGateway: GATEWAY,
    result,
    unattributableCount: 0,
    provenance: { production: 0, staging: 1, unknown: 0 },
  };
}

const STAGING_RP = 'rp_c357f900d4501523';
const STAGING: Provenance = { environment: 'staging', rpId: STAGING_RP };

const EMPTY: PublishedState = { reviews: new Map(), latestSnapshots: new Map() };
const DAY_BLOCKS = 86_400n / RABDI_BLOCK_SECONDS;

// ---------------------------------------------------------------------------

describe('arkiv: nothing private is published', () => {
  const FORBIDDEN = /nullifier|signature|proof|nonce|world|secret|private/i;

  // The two World ID provenance columns are the only exception, by name, and
  // the tests below pin what they may hold: one of four labels and a public
  // RP id. Any other column matching FORBIDDEN still fails.
  const PUBLIC_WORLD_ID_COLUMNS = new Set(['worldIdEnvironment', 'worldIdRpId']);

  it('no column of either schema is named after private data', () => {
    for (const schema of [ReviewSchema, ReputationSchema]) {
      for (const name of Object.keys(schema.columns)) {
        if (PUBLIC_WORLD_ID_COLUMNS.has(name) && schema === ReviewSchema) continue;
        expect(name).not.toMatch(FORBIDDEN);
      }
    }
    expect(Object.keys(ReviewSchema.columns)).toEqual(
      expect.arrayContaining([...PUBLIC_WORLD_ID_COLUMNS]),
    );
  });

  it('the World ID columns hold only an environment label and a public RP id', async () => {
    const values = reviewEntityValues(review(), 1, null, STAGING);
    expect(values.worldIdEnvironment).toBe('staging');
    expect(values.worldIdRpId).toMatch(/^rp_[0-9a-f]{16}$/);
    const unknown = reviewEntityValues(review(), 1, null, { environment: 'unknown' });
    expect(unknown.worldIdEnvironment).toBe('unknown');
    expect(unknown).not.toHaveProperty('worldIdRpId');
  });

  it('the indexer drops the nullifier, so no plan can contain it', async () => {
    const client = fakeChain({
      head: 12_070_100n,
      submitted: [submittedLog(1, 12_070_000n)],
      feedback: [feedbackLog(1, 12_070_000n)],
    });
    const { reviews } = await indexConfirmedReviews({
      client,
      reputationRegistry: REGISTRY,
      gateways: [{ address: GATEWAY, fromBlock: 12_064_002n }],
      confirmations: 12n,
    });
    expect(reviews).toHaveLength(1);
    expect(Object.keys(reviews[0] ?? {})).not.toContain('nullifier');

    const plan = await planPublication({
      chainId: 11155111,
      reviews,
      contentFor: async () => CONTENT,
      provenanceFor: async () => STAGING,
      snapshots: [snapshot()],
      published: EMPTY,
      arkivBlock: 1n,
    });
    const file = JSON.stringify(toPlanFile(plan, REVIEWER, 7794095));
    expect(file.toLowerCase()).not.toContain(NULLIFIER.slice(2));
  });

  it('a reputation snapshot carries the manifest hash, never the manifest', () => {
    const scored = computeReputation(fiveHumans());
    const values = reputationEntityValues(snapshot(scored));
    expect(
      JSON.stringify(values, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toMatch(/nullifier|0x(ee|ef|f0|f1|f2){32}/);
    expect(values.manifestHash).toBe(`0x${'cd'.repeat(32)}`);
  });
});

describe('arkiv: review records', () => {
  it('keeps content only when it hashes to the on-chain feedbackHash', () => {
    expect(verifiedContent(review(), CONTENT)).toBe(CONTENT);
    expect(verifiedContent(review(), toBytes('something else'))).toBeNull();
    expect(verifiedContent(review(), null)).toBeNull();

    const tampered = reviewEntityValues(review(), 11155111, toBytes('swapped text'), STAGING);
    expect(tampered.content).toBeUndefined();
  });

  it('omits receiptId for an unpaid review and keeps it for a paid one', () => {
    expect(reviewEntityValues(review(), 1, null, STAGING).receiptId).toBeUndefined();
    const paid = reviewEntityValues(
      review({ reviewType: 1, tag: 'receipt-verified', receiptId: `0x${'0F'.repeat(32)}` }),
      1,
      null,
      STAGING,
    );
    expect(paid.receiptId).toBe(`0x${'0f'.repeat(32)}`);
  });

  it('refuses a review whose tag contradicts its type, or whose value is out of range', () => {
    expect(() => reviewEntityValues(review({ tag: 'receipt-verified' }), 1, null, STAGING)).toThrow(
      /tag/,
    );
    expect(() => reviewEntityValues(review({ value: 101n }), 1, null, STAGING)).toThrow(/range/);
  });

  it('identifies a review by transaction and log index', () => {
    expect(reviewId(review({ txHash: txHash(0xab) }))).toBe(`${txHash(0xab)}:3`);
  });
});

describe('arkiv: indexer', () => {
  it('stops `confirmations` blocks behind the head', async () => {
    const client = fakeChain({ head: 12_070_100n, submitted: [], feedback: [] });
    const result = await indexConfirmedReviews({
      client,
      reputationRegistry: REGISTRY,
      gateways: [{ address: GATEWAY, fromBlock: 12_064_002n }],
      confirmations: 12n,
    });
    expect(result.toBlock).toBe(12_070_088n);
    expect(client.calls.every((c) => c.toBlock <= 12_070_088n)).toBe(true);
  });

  it('skips a transaction whose two events disagree, or that has only one of them', async () => {
    const client = fakeChain({
      head: 12_080_000n,
      submitted: [submittedLog(1, 12_070_000n), submittedLog(2, 12_070_001n)],
      feedback: [
        feedbackLog(1, 12_070_000n, { feedbackHash: `0x${'99'.repeat(32)}` }),
        feedbackLog(3, 12_070_002n),
      ],
    });
    const result = await indexConfirmedReviews({
      client,
      reputationRegistry: REGISTRY,
      gateways: [{ address: GATEWAY, fromBlock: 12_064_002n }],
      confirmations: 12n,
    });
    expect(result.reviews).toHaveLength(0);
    expect(result.skipped.map((s) => s.detail).join('\n')).toMatch(/disagree/);
    expect(result.skipped.map((s) => s.detail).join('\n')).toMatch(/0 NewFeedback/);
    expect(result.skipped.map((s) => s.detail).join('\n')).toMatch(
      /NewFeedback with no ReviewSubmitted/,
    );
  });
});

describe('arkiv: planning', () => {
  it('does not publish a review that is already on Arkiv', async () => {
    const r = review();
    const published: PublishedState = {
      reviews: new Map([
        [reviewId(r), { entityKey: txHash(9), expiresAt: 1n + 100n * DAY_BLOCKS }],
      ]),
      latestSnapshots: new Map(),
    };
    const plan = await planPublication({
      chainId: 1,
      reviews: [r],
      contentFor: async () => CONTENT,
      provenanceFor: async () => STAGING,
      snapshots: [],
      published,
      arkivBlock: 1n,
    });
    expect(plan.creates).toHaveLength(0);
    expect(plan.extensions).toHaveLength(0);
    expect(plan.unchanged).toHaveLength(1);
  });

  it('renews a published review once less than 30 days of life remain', async () => {
    const r = review();
    const plan = await planPublication({
      chainId: 1,
      reviews: [r],
      contentFor: async () => CONTENT,
      provenanceFor: async () => STAGING,
      snapshots: [],
      published: {
        reviews: new Map([
          [reviewId(r), { entityKey: txHash(9), expiresAt: 1_000n + 29n * DAY_BLOCKS }],
        ]),
        latestSnapshots: new Map(),
      },
      arkivBlock: 1_000n,
    });
    expect(plan.extensions).toEqual([
      { kind: 'review', entityKey: txHash(9), reason: expect.any(String) },
    ]);
  });

  it('extends an unchanged snapshot instead of writing a duplicate, and writes a changed one', async () => {
    const s = snapshot();
    const fingerprint = snapshotFingerprint(
      reputationEntityValues(s) as Parameters<typeof snapshotFingerprint>[0],
    );
    const latest = (expiresAt: bigint, fp = fingerprint) => ({
      reviews: new Map(),
      latestSnapshots: new Map([['42', { entityKey: txHash(7), expiresAt, fingerprint: fp }]]),
    });

    const fresh = await planPublication({
      chainId: 1,
      reviews: [],
      contentFor: async () => null,
      provenanceFor: async () => STAGING,
      snapshots: [s],
      published: latest(1_000n + 7n * DAY_BLOCKS),
      arkivBlock: 1_000n,
    });
    expect(fresh.creates).toHaveLength(0);
    expect(fresh.extensions).toHaveLength(0);

    const ageing = await planPublication({
      chainId: 1,
      reviews: [],
      contentFor: async () => null,
      provenanceFor: async () => STAGING,
      snapshots: [s],
      published: latest(1_000n + 2n * DAY_BLOCKS),
      arkivBlock: 1_000n,
    });
    expect(ageing.extensions.map((e) => e.entityKey)).toEqual([txHash(7)]);

    const changed = await planPublication({
      chainId: 1,
      reviews: [],
      contentFor: async () => null,
      provenanceFor: async () => STAGING,
      snapshots: [s],
      published: latest(1_000n + 7n * DAY_BLOCKS, 'something-else'),
      arkivBlock: 1_000n,
    });
    expect(changed.creates.map((c) => c.kind)).toEqual(['reputation']);

    const expired = await planPublication({
      chainId: 1,
      reviews: [],
      contentFor: async () => null,
      provenanceFor: async () => STAGING,
      snapshots: [s],
      published: latest(999n),
      arkivBlock: 1_000n,
    });
    expect(expired.creates.map((c) => c.kind)).toEqual(['reputation']);
  });

  it('reports a malformed review as refused rather than failing the run', async () => {
    const plan = await planPublication({
      chainId: 1,
      reviews: [review({ tag: 'wallet-verified' }), review({ txHash: txHash(2) })],
      contentFor: async () => CONTENT,
      provenanceFor: async () => STAGING,
      snapshots: [],
      published: EMPTY,
      arkivBlock: 1n,
    });
    expect(plan.refused).toHaveLength(1);
    expect(plan.creates).toHaveLength(1);
  });
});

describe('arkiv: the approved plan is the executed plan', () => {
  async function samplePlan() {
    return planPublication({
      chainId: 11155111,
      reviews: [
        review(),
        review({
          txHash: txHash(2),
          reviewType: 1,
          tag: 'receipt-verified',
          receiptId: `0x${'0f'.repeat(32)}`,
        }),
      ],
      contentFor: async () => CONTENT,
      provenanceFor: async () => STAGING,
      snapshots: [snapshot(computeReputation(fiveHumans()))],
      published: EMPTY,
      arkivBlock: 1n,
    });
  }

  it('round-trips through the plan file and hashes stably', async () => {
    const plan = await samplePlan();
    const file = toPlanFile(plan, REVIEWER, 7794095);
    const reread = JSON.parse(JSON.stringify(file)) as typeof file;
    expect(planFileHash(reread)).toBe(planFileHash(file));
    expect(toPlanFile(fromPlanFile(reread), REVIEWER, 7794095)).toEqual(file);
  });

  it('any edit to the file changes its hash', async () => {
    const file = toPlanFile(await samplePlan(), REVIEWER, 7794095);
    const edited = JSON.parse(JSON.stringify(file));
    edited.creates[0].values.value = 100;
    expect(planFileHash(edited)).not.toBe(planFileHash(file));
  });

  it('the SDK accepts every planned value against its schema', async () => {
    // A transport that answers the block number and refuses everything after.
    // The SDK validates every create against its schema before its first
    // network call, so reaching the refusal means validation passed.
    const plan = fromPlanFile(
      JSON.parse(JSON.stringify(toPlanFile(await samplePlan(), REVIEWER, 7794095))),
    );
    const seen: string[] = [];
    const wallet = createWalletClient({
      chain: rabdi({ accessKey: 'test' }),
      account: privateKeyToAccount(`0x${'11'.repeat(32)}`),
      transport: custom({
        async request({ method }) {
          seen.push(method);
          if (method === 'eth_blockNumber') return '0x1000';
          throw new Error('stop: no network in tests');
        },
      }),
    });
    // The SDK wraps the refusal in its own error, so what proves validation
    // passed is how far it got: past the block read and on to estimating gas.
    await expect(executePlan(wallet, plan)).rejects.toThrow();
    expect(seen[0]).toBe('eth_blockNumber');
    expect(seen).toContain('eth_estimateGas');
    expect(seen).not.toContain('eth_sendRawTransaction');
  });

  it('a value that does not fit the schema fails before any network call', async () => {
    const plan = await samplePlan();
    const broken = {
      ...plan,
      creates: [{ ...plan.creates[0], values: { ...plan.creates[0]?.values, value: 'high' } }],
    };
    const seen: string[] = [];
    const wallet = createWalletClient({
      chain: rabdi({ accessKey: 'test' }),
      account: privateKeyToAccount(`0x${'11'.repeat(32)}`),
      transport: custom({
        async request({ method }) {
          seen.push(method);
          throw new Error('network');
        },
      }),
    });
    await expect(executePlan(wallet, broken as never)).rejects.not.toThrow(/network/);
    expect(seen).toEqual([]);
  });

  it('executes only the confirmed file, for its own publisher and chain', async () => {
    const file = toPlanFile(await samplePlan(), REVIEWER, 7794095);
    const approval = { confirm: planFileHash(file), signer: REVIEWER, arkivChainId: 7794095 };
    expect(() => checkApprovedPlan(file, approval)).not.toThrow();
    // Checksum casing of the signer is not a different publisher.
    expect(() =>
      checkApprovedPlan(file, { ...approval, signer: REVIEWER.toUpperCase() as Address }),
    ).not.toThrow();

    const edited = JSON.parse(JSON.stringify(file));
    edited.creates[0].values.value = 100;
    expect(() => checkApprovedPlan(edited, approval)).toThrow(PlanApprovalError);
    expect(() =>
      checkApprovedPlan(file, { ...approval, signer: `0x${'22'.repeat(20)}` as Address }),
    ).toThrow(/different publisher/);
    expect(() => checkApprovedPlan(file, { ...approval, arkivChainId: 1 })).toThrow(
      /different Arkiv chain/,
    );
  });

  it('refuses a publisher that is the attestation signer, whatever its casing', () => {
    const signer = '0x203d0f8C67C66ebbbe1fe34A1E9f86aDc67da363' as Address;
    expect(() => assertSeparateFromSigner(signer, signer.toLowerCase() as Address)).toThrow(
      /recordServerSigner/,
    );
    expect(() => assertSeparateFromSigner(signer, REVIEWER)).not.toThrow();
  });

  it('creates reviews for the maximum lifetime and snapshots for seven days, both readonly', async () => {
    const plan = fromPlanFile(
      JSON.parse(JSON.stringify(toPlanFile(await samplePlan(), REVIEWER, 7794095))),
    );
    const sent: { creates: { schema: unknown; expiration: unknown; flags: unknown }[] }[] = [];
    const wallet = {
      async executeBatch(batch: (typeof sent)[number]) {
        sent.push(batch);
        return {
          txHash: txHash(99),
          createdEntities: batch.creates.map((_, i) => txHash(100 + i)),
        };
      },
    };
    const [result] = await executePlan(wallet as never, plan);
    const creates = sent[0]?.creates ?? [];
    expect(creates.map((c) => c.schema)).toEqual([ReviewSchema, ReviewSchema, ReputationSchema]);
    // 7,884,000 and 302,400 blocks at two seconds: about 182 days, and 7 days.
    expect(creates.map((c) => c.expiration)).toEqual([
      { minLifetime: 7_884_000n, expiresAt: 0n },
      { minLifetime: 7_884_000n, expiresAt: 0n },
      { minLifetime: 7n * DAY_BLOCKS, expiresAt: 0n },
    ]);
    expect(creates.map((c) => c.flags)).toEqual([
      CREATE_POLICY.review.flags,
      CREATE_POLICY.review.flags,
      CREATE_POLICY.reputation.flags,
    ]);
    expect(CREATE_POLICY.review.flags.readonly && CREATE_POLICY.reputation.flags.readonly).toBe(
      true,
    );
    expect(result?.created.map((c) => c.entityKey)).toEqual([
      txHash(100),
      txHash(101),
      txHash(102),
    ]);
  });

  it('batches creates then extensions, at most ten per transaction', () => {
    const creates = Array.from({ length: 13 }, (_, i) => ({
      kind: 'review' as const,
      id: String(i),
      values: {} as never,
    }));
    const extensions = Array.from({ length: 4 }, (_, i) => ({
      kind: 'reputation' as const,
      entityKey: txHash(i),
      reason: '',
    }));
    const chunks = chunkPlan({ creates, extensions, unchanged: [], refused: [] });
    expect(chunks.map((c) => [c.creates.length, c.extensions.length])).toEqual([
      [10, 0],
      [3, 4],
    ]);
  });
});

// --- fixtures ---------------------------------------------------------------

function fiveHumans(): ReviewInput[] {
  return [0, 1, 2, 3, 4].map((i) => ({
    nullifier: `0x${['ee', 'ef', 'f0', 'f1', 'f2'][i]!.repeat(32)}`,
    reviewer: `0x${String(i + 2).repeat(40)}`,
    value: BigInt(70 + i),
    valueDecimals: 0,
    reviewType: 0,
    revoked: false,
    feedbackIndex: BigInt(i + 1),
    blockNumber: 12_070_000n + BigInt(i),
    logIndex: 0,
  }));
}

function submittedLog(tx: number, block: bigint) {
  return {
    transactionHash: txHash(tx),
    logIndex: 3,
    blockNumber: block,
    args: {
      agentId: 42n,
      reviewer: REVIEWER,
      nullifier: NULLIFIER,
      reviewType: 0,
      receiptId: ZERO32,
      feedbackHash: CONTENT_HASH,
    },
  };
}

function feedbackLog(tx: number, block: bigint, overrides: { feedbackHash?: Hex } = {}) {
  return {
    transactionHash: txHash(tx),
    logIndex: 2,
    blockNumber: block,
    args: {
      agentId: 42n,
      clientAddress: GATEWAY,
      feedbackIndex: BigInt(tx),
      value: 87n,
      valueDecimals: 0,
      tag1: 'quality',
      tag2: 'human-verified',
      feedbackHash: overrides.feedbackHash ?? CONTENT_HASH,
    },
  };
}

function fakeChain(input: {
  head: bigint;
  submitted: ReturnType<typeof submittedLog>[];
  feedback: ReturnType<typeof feedbackLog>[];
}): PublicClient & { calls: { eventName: string; toBlock: bigint }[] } {
  const calls: { eventName: string; toBlock: bigint }[] = [];
  const inRange = (b: bigint, from: bigint, to: bigint) => b >= from && b <= to;
  return {
    calls,
    getBlockNumber: async () => input.head,
    getContractEvents: async (args: { eventName: string; fromBlock: bigint; toBlock: bigint }) => {
      calls.push({ eventName: args.eventName, toBlock: args.toBlock });
      const source = args.eventName === 'ReviewSubmitted' ? input.submitted : input.feedback;
      return source.filter((l) => inRange(l.blockNumber, args.fromBlock, args.toBlock));
    },
  } as unknown as PublicClient & { calls: { eventName: string; toBlock: bigint }[] };
}

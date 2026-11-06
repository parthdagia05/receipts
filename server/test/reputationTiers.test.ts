import { describe, expect, it } from 'vitest';
import { computeReputation } from '../src/reputation/engine.js';
import type { ReviewInput } from '../src/reputation/engine.js';
import { buildManifest, manifestHash } from '../src/reputation/evidence.js';
import { retrieveReviews } from '../src/reputation/retrieval.js';
import {
  REVIEW_TYPE_FREE,
  REVIEW_TYPE_PAID,
  REVIEW_TYPE_WALLET,
  SPEC_VERSION,
  walletNullifier,
} from '../src/reputation/spec.js';
import { reputationRoute } from '../src/routes/reputation.js';
import { reputationSimulateRoute } from '../src/routes/reputationSimulate.js';

/**
 * Reputation tiers (spec v1.1).
 *
 * The invariant under test throughout: a wallet-verified review (type 2) is
 * informational. It never moves the human score, the distinct-human count,
 * the total weight, or the five-human threshold.
 */

const GATEWAY_A = '0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD' as const;
const GATEWAY_B = '0x00000000000000000000000000000000000000B2' as const;
const SETTLER = '0xC3AA7a2F43d83680f9E0B97e0Eb4fD01E421ceDe' as const;
const REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713' as const;
const ZERO32 = `0x${'00'.repeat(32)}`;

let seq = 0;
function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

function human(value: bigint, over: Partial<ReviewInput> = {}): ReviewInput {
  seq += 1;
  return {
    nullifier: `0xhuman${seq}`,
    reviewer: addr(1000 + seq),
    value,
    valueDecimals: 0,
    reviewType: REVIEW_TYPE_FREE,
    revoked: false,
    feedbackIndex: BigInt(seq),
    blockNumber: BigInt(seq),
    logIndex: 0,
    ...over,
  };
}

function paid(value: bigint, amount = 1_000_000n, over: Partial<ReviewInput> = {}): ReviewInput {
  return human(value, { reviewType: REVIEW_TYPE_PAID, paymentAmount: amount, ...over });
}

function wallet(value: bigint, over: Partial<ReviewInput> = {}): ReviewInput {
  seq += 1;
  const reviewer = addr(5000 + seq);
  return {
    nullifier: walletNullifier(reviewer),
    reviewer,
    value,
    valueDecimals: 0,
    reviewType: REVIEW_TYPE_WALLET,
    revoked: false,
    feedbackIndex: BigInt(seq),
    blockNumber: BigInt(seq),
    logIndex: 0,
    ...over,
  };
}

/** Strip the reviewer, as untyped or cast input could. */
function withoutReviewer(r: ReviewInput): ReviewInput {
  const { reviewer: _dropped, ...rest } = r;
  void _dropped;
  return rest as unknown as ReviewInput;
}

const fiveHumans = () => [10n, 20n, 30n, 40n, 50n].map((v) => human(v));

describe('wallet reviews never reach the human score', () => {
  it('leaves the human score unchanged for any number of wallet reviews', () => {
    const base = fiveHumans();
    const without = computeReputation(base);
    for (const n of [1, 5, 50, 300]) {
      const withWallet = computeReputation([
        ...base,
        ...Array.from({ length: n }, () => wallet(100n)),
      ]);
      expect(withWallet.score).toBe(without.score);
      expect(withWallet.distinctHumans).toBe(without.distinctHumans);
      expect(withWallet.totalWeight).toBe(without.totalWeight);
      expect(withWallet.eligible).toEqual(without.eligible);
      expect(withWallet.tiers.human).toEqual(without.tiers.human);
      expect(withWallet.tiers.wallet.count).toBe(n);
    }
  });

  it('publishes no human score from ten wallet reviews alone', () => {
    const result = computeReputation(Array.from({ length: 10 }, () => wallet(90n)));
    expect(result.score).toBeNull();
    expect(result.status).toBe('no_eligible_reviews');
    expect(result.distinctHumans).toBe(0);
    expect(result.tiers.human.score).toBeNull();
    expect(result.tiers.receipt.score).toBeNull();
    expect(result.tiers.wallet.count).toBe(10);
  });

  it('keeps four humans below the five-human threshold despite ten wallets', () => {
    const result = computeReputation([
      ...[10n, 20n, 30n, 40n].map((v) => human(v)),
      ...Array.from({ length: 10 }, () => wallet(100n)),
    ]);
    expect(result.status).toBe('below_threshold');
    expect(result.score).toBeNull();
    expect(result.distinctHumans).toBe(4);
    expect(result.tiers.wallet.count).toBe(10);
  });

  it('reports wallets as informational: no score, no weight, threshold 0', () => {
    const { wallet: w } = computeReputation([wallet(80n), wallet(60n)]).tiers;
    expect(w.score).toBeNull();
    expect(w.status).toBe('informational');
    expect(w.count).toBe(2);
    expect(w.threshold).toBe(0);
    expect(w.totalWeight).toBe(0n);
  });

  it('does not let wallet extremes drag the median', () => {
    const result = computeReputation([
      ...fiveHumans(),
      ...Array.from({ length: 40 }, () => wallet(0n)),
    ]);
    expect(result.score).toBe(30n);
  });
});

describe('type and nullifier rules', () => {
  it.each([REVIEW_TYPE_FREE, REVIEW_TYPE_PAID])(
    'excludes a type-%i review carrying a wallet nullifier',
    (reviewType) => {
      const reviewer = addr(777);
      const spoof = human(100n, {
        reviewType,
        reviewer,
        nullifier: walletNullifier(reviewer),
        paymentAmount: 1_000_000n,
      });
      const result = computeReputation([...fiveHumans(), spoof]);
      expect(result.excluded).toContainEqual(
        expect.objectContaining({ reason: 'wallet_nullifier_on_human_review' }),
      );
      expect(result.distinctHumans).toBe(5);
      expect(result.score).toBe(30n);
    },
  );

  it('catches a differently-cased wallet nullifier on a human review', () => {
    const reviewer = addr(778);
    const result = computeReputation([
      human(100n, {
        reviewer,
        nullifier: walletNullifier(reviewer).toUpperCase().replace('0X', '0x'),
      }),
    ]);
    expect(result.excluded[0]?.reason).toBe('wallet_nullifier_on_human_review');
  });

  it('excludes unknown review types and never scores them', () => {
    for (const reviewType of [3, 7, 255]) {
      const result = computeReputation([...fiveHumans(), human(100n, { reviewType })]);
      expect(result.excluded).toContainEqual(
        expect.objectContaining({ reason: 'unknown_review_type' }),
      );
      expect(result.distinctHumans).toBe(5);
      expect(result.tiers.wallet.count).toBe(0);
    }
  });

  it('excludes a wallet review whose nullifier is not the wallet derivation', () => {
    const bad = wallet(90n, { nullifier: '0xnotawalletnullifier' });
    const noReviewer = withoutReviewer(wallet(90n));
    const result = computeReputation([bad, noReviewer]);
    expect(result.tiers.wallet.count).toBe(0);
    expect(result.tiers.wallet.excluded.map((e) => e.reason).sort()).toEqual([
      'invalid_wallet_nullifier',
      'missing_reviewer',
    ]);
  });

  it('counts a wallet once and drops revoked or malformed ones', () => {
    const a = wallet(50n);
    const result = computeReputation([
      a,
      { ...a, feedbackIndex: 99n, blockNumber: 99n },
      wallet(50n, { revoked: true }),
      wallet(50n, { valueDecimals: 2 }),
      wallet(101n),
    ]);
    expect(result.tiers.wallet.count).toBe(1);
    expect(result.tiers.wallet.excluded.map((e) => e.reason).sort()).toEqual([
      'duplicate_nullifier',
      'invalid_decimals',
      'rating_out_of_range',
      'revoked',
    ]);
  });
});

describe('a missing reviewer fails closed (wallet-nullifier defense cannot be skipped)', () => {
  const makers: [string, (over?: Partial<ReviewInput>) => ReviewInput][] = [
    ['type 0', (o) => human(100n, o)],
    ['type 1', (o) => paid(100n, 1_000_000n, o)],
    ['type 2', (o) => wallet(100n, o)],
  ];

  it.each(makers)('excludes a %s review with no reviewer and never scores it', (_n, make) => {
    const result = computeReputation([...fiveHumans(), withoutReviewer(make())]);
    // Nothing from the stripped review reaches any tier.
    expect(result.distinctHumans).toBe(5);
    expect(result.score).toBe(30n);
    expect(result.totalWeight).toBe(5_000_000n);
    expect(result.tiers.receipt.count).toBe(0);
    expect(result.tiers.wallet.count).toBe(0);
    const reasons = [...result.excluded, ...result.tiers.wallet.excluded].map((e) => e.reason);
    expect(reasons).toEqual(['missing_reviewer']);
  });

  it.each(makers)('excludes a %s review with an empty or malformed reviewer', (_n, make) => {
    for (const reviewer of ['', 'not-an-address', '0x1234', `0x${'zz'.repeat(20)}`]) {
      const result = computeReputation([...fiveHumans(), make({ reviewer })]);
      expect(result.distinctHumans).toBe(5);
      expect(result.tiers.wallet.count).toBe(0);
      const reasons = [...result.excluded, ...result.tiers.wallet.excluded].map((e) => e.reason);
      expect(reasons).toEqual([reviewer === '' ? 'missing_reviewer' : 'invalid_reviewer']);
    }
  });

  it('does not let a wallet-derived nullifier slip into the human score by omitting the reviewer', () => {
    // The attack the defense exists for: a wallet identity on a type-0/1
    // review. With the reviewer stripped the nullifier cannot be recognised,
    // so the review must be refused rather than waved through.
    for (const reviewType of [REVIEW_TYPE_FREE, REVIEW_TYPE_PAID]) {
      const reviewer = addr(4321);
      const spoof = withoutReviewer(
        human(100n, {
          reviewType,
          reviewer,
          nullifier: walletNullifier(reviewer),
          paymentAmount: 1_000_000n,
        }),
      );
      const result = computeReputation([...[10n, 20n, 30n, 40n].map((v) => human(v)), spoof]);
      expect(result.status).toBe('below_threshold');
      expect(result.distinctHumans).toBe(4);
      expect(result.excluded).toContainEqual(
        expect.objectContaining({ reason: 'missing_reviewer' }),
      );
    }
  });

  it('is exercised by the type system as well: reviewer is a required field', () => {
    // @ts-expect-error reviewer is mandatory on ReviewInput
    const missing: ReviewInput = {
      nullifier: '0xn',
      value: 1n,
      valueDecimals: 0,
      reviewType: 0,
      revoked: false,
      feedbackIndex: 1n,
      blockNumber: 1n,
      logIndex: 0,
    };
    expect(computeReputation([missing]).distinctHumans).toBe(0);
  });
});

describe('overlapping human and receipt tiers', () => {
  it('counts a paid review in both human and receipt tiers', () => {
    const result = computeReputation([
      ...[10n, 20n, 30n, 40n, 50n].map((v) => paid(v, 10_000_000n)),
      human(90n),
    ]);
    expect(result.tiers.human.count).toBe(6);
    expect(result.tiers.receipt.count).toBe(5);
    expect(result.tiers.receipt.status).toBe('published');
    expect(result.tiers.receipt.totalWeight).toBe(10_000_000n);
    expect(result.humanVerifiedCount).toBe(1);
    expect(result.receiptVerifiedCount).toBe(5);
  });

  it('publishes human and receipt tiers independently', () => {
    const result = computeReputation([...fiveHumans(), paid(60n), paid(70n)]);
    expect(result.tiers.human.status).toBe('published');
    expect(result.tiers.receipt.status).toBe('below_threshold');
    expect(result.tiers.receipt.score).toBeNull();
  });

  it('keeps the human tier identical to the legacy top-level result', () => {
    const result = computeReputation([...fiveHumans(), paid(60n, 5_000_000n)]);
    expect(result.tiers.human.score).toBe(result.score);
    expect(result.tiers.human.status).toBe(result.status);
    expect(result.tiers.human.count).toBe(result.distinctHumans);
    expect(result.tiers.human.totalWeight).toBe(result.totalWeight);
  });
});

/* ------------------------------------------------------------------------ */
/* Retrieval                                                                 */
/* ------------------------------------------------------------------------ */

interface ChainFixture {
  feedback: { gateway: string; log: Record<string, unknown> }[];
  reviews: { gateway: string; log: Record<string, unknown> }[];
  /** Revoked flag per `${gatewayLower}:${index}`. */
  revoked: Record<string, boolean>;
  receipts?: Record<string, unknown[]>;
}

function chainClient(chain: ChainFixture) {
  return {
    getBlockNumber: async () => 500n,
    getContractEvents: async ({
      eventName,
      args,
      address,
    }: {
      eventName: string;
      args: { clientAddress?: string };
      address: string;
    }) => {
      if (eventName === 'NewFeedback') {
        const gw = String(args.clientAddress).toLowerCase();
        return chain.feedback.filter((f) => f.gateway.toLowerCase() === gw).map((f) => f.log);
      }
      const gw = address.toLowerCase();
      return chain.reviews.filter((r) => r.gateway.toLowerCase() === gw).map((r) => r.log);
    },
    readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      if (functionName === 'readAllFeedback') {
        const gw = String((args[1] as string[])[0]).toLowerCase();
        const rows = Object.entries(chain.revoked).filter(([k]) => k.startsWith(`${gw}:`));
        const n = rows.length;
        return [
          Array.from({ length: n }, () => gw),
          rows.map(([k]) => BigInt(k.split(':')[1] as string)),
          Array.from({ length: n }, () => 50n),
          Array.from({ length: n }, () => 0),
          Array.from({ length: n }, () => 'quality'),
          Array.from({ length: n }, () => 'x'),
          rows.map(([, v]) => v),
        ];
      }
      const receipt = chain.receipts?.[String(args[0])];
      if (receipt === undefined) throw new Error('no receipt');
      return receipt;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

let txn = 0;
function pair(
  gateway: string,
  index: bigint,
  over: {
    reviewType?: number;
    tag2?: string;
    nullifier?: string;
    reviewer?: string;
    receiptId?: string;
    block?: bigint;
  } = {},
) {
  txn += 1;
  const tx = `0xtx${txn}`;
  const reviewType = over.reviewType ?? 0;
  const tag2 =
    over.tag2 ?? ['human-verified', 'receipt-verified', 'wallet-verified'][reviewType] ?? 'x';
  const reviewer = over.reviewer ?? addr(9000 + txn);
  const nullifier =
    over.nullifier ??
    (reviewType === REVIEW_TYPE_WALLET ? walletNullifier(reviewer as `0x${string}`) : `0xhn${txn}`);
  const block = over.block ?? BigInt(10 + txn);
  return {
    feedback: {
      gateway,
      log: {
        transactionHash: tx,
        blockNumber: block,
        logIndex: 0,
        args: {
          feedbackIndex: index,
          value: 50n,
          valueDecimals: 0,
          tag1: 'quality',
          tag2,
          feedbackHash: `0xfh${txn}`,
        },
      },
    },
    review: {
      gateway,
      log: {
        transactionHash: tx,
        blockNumber: block,
        logIndex: 1,
        args: {
          nullifier,
          reviewer,
          reviewType,
          receiptId: over.receiptId ?? ZERO32,
          feedbackHash: `0xfh${txn}`,
        },
      },
    },
  };
}

function cfg(client: unknown, extra: Record<string, unknown> = {}) {
  return {
    client,
    reviewGateway: GATEWAY_A,
    receiptSettler: SETTLER,
    reputationRegistry: REGISTRY,
    fromBlock: 0n,
    maxLogRange: 10_000n,
    ...extra,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function build(pairs: ReturnType<typeof pair>[], revoked: Record<string, boolean>) {
  return chainClient({
    feedback: pairs.map((p) => p.feedback),
    reviews: pairs.map((p) => p.review),
    revoked,
  });
}

describe('retrieval type/tag combinations', () => {
  it('accepts 0+human-verified and 2+wallet-verified, and passes the reviewer through', async () => {
    const h = pair(GATEWAY_A, 1n, { reviewType: 0 });
    const w = pair(GATEWAY_A, 2n, { reviewType: 2 });
    const out = await retrieveReviews(
      cfg(
        build([h, w], {
          [`${GATEWAY_A.toLowerCase()}:1`]: false,
          [`${GATEWAY_A.toLowerCase()}:2`]: false,
        }),
      ),
      1n,
    );
    expect(out.unattributable).toEqual([]);
    expect(out.reviews.map((r) => r.reviewType).sort()).toEqual([0, 2]);
    expect(out.reviews.every((r) => r.reviewer !== undefined)).toBe(true);
    const scored = computeReputation(out.reviews);
    expect(scored.tiers.wallet.count).toBe(1);
    expect(scored.distinctHumans).toBe(1);
  });

  it('accepts 1+receipt-verified with a settled receipt', async () => {
    const reviewer = addr(4242);
    const receiptId = `0x${'ab'.repeat(32)}`;
    const p = pair(GATEWAY_A, 1n, { reviewType: 1, receiptId, reviewer });
    const client = chainClient({
      feedback: [p.feedback],
      reviews: [p.review],
      revoked: { [`${GATEWAY_A.toLowerCase()}:1`]: false },
      receipts: { [receiptId]: [reviewer, 1n, 3_000_000n, 1n, true, ZERO32] },
    });
    const out = await retrieveReviews(cfg(client), 1n);
    expect(out.unattributable).toEqual([]);
    expect(out.reviews[0]?.paymentAmount).toBe(3_000_000n);
  });

  it.each([
    ['type 2 tagged human-verified', { reviewType: 2, tag2: 'human-verified' }],
    ['type 0 tagged wallet-verified', { reviewType: 0, tag2: 'wallet-verified' }],
    ['type 1 tagged wallet-verified', { reviewType: 1, tag2: 'wallet-verified' }],
    ['type 0 tagged receipt-verified', { reviewType: 0, tag2: 'receipt-verified' }],
    ['unknown type 3', { reviewType: 3, tag2: 'human-verified' }],
    ['unknown type 3 tagged wallet-verified', { reviewType: 3, tag2: 'wallet-verified' }],
    ['type 2 carrying a receipt id', { reviewType: 2, receiptId: `0x${'cd'.repeat(32)}` }],
  ])('rejects %s as unattributable', async (_name, over) => {
    const p = pair(GATEWAY_A, 1n, over);
    const out = await retrieveReviews(
      cfg(build([p], { [`${GATEWAY_A.toLowerCase()}:1`]: false })),
      1n,
    );
    expect(out.reviews).toHaveLength(0);
    // (A stub receipt that cannot be read adds its own entry; at least one
    // entry must be the rejection of this pair.)
    expect(out.unattributable.some((u) => u.detail.startsWith('tx '))).toBe(true);
  });

  it('no longer reads a wallet entry as human-verified', async () => {
    // The old rule mapped every non-paid type to the free tag; a type-2 entry
    // tagged human-verified would have scored as a human.
    const p = pair(GATEWAY_A, 1n, { reviewType: 2, tag2: 'human-verified' });
    const out = await retrieveReviews(
      cfg(build([p], { [`${GATEWAY_A.toLowerCase()}:1`]: false })),
      1n,
    );
    expect(computeReputation(out.reviews).distinctHumans).toBe(0);
  });
});

describe('multiple gateways', () => {
  const a = GATEWAY_A.toLowerCase();
  const b = GATEWAY_B.toLowerCase();

  it('preserves history from every listed gateway', async () => {
    const pairs = [
      pair(GATEWAY_A, 1n, { reviewType: 0 }),
      pair(GATEWAY_A, 2n, { reviewType: 0 }),
      pair(GATEWAY_B, 1n, { reviewType: 0 }),
      pair(GATEWAY_B, 2n, { reviewType: 2 }),
    ];
    const client = build(pairs, {
      [`${a}:1`]: false,
      [`${a}:2`]: false,
      [`${b}:1`]: false,
      [`${b}:2`]: false,
    });
    const out = await retrieveReviews(
      cfg(client, {
        reviewGateway: GATEWAY_B,
        fromBlock: 5n,
        gateways: [{ address: GATEWAY_A, fromBlock: 0n }],
      }),
      1n,
    );
    expect(out.unattributable).toEqual([]);
    expect(out.reviews).toHaveLength(4);
    expect(new Set(out.reviews.map((r) => r.gateway))).toEqual(new Set([a, b]));
    const scored = computeReputation(out.reviews);
    expect(scored.distinctHumans).toBe(3);
    expect(scored.tiers.wallet.count).toBe(1);
  });

  it('keys revocation by gateway, since feedback indexes repeat across gateways', async () => {
    const pairs = [pair(GATEWAY_A, 1n), pair(GATEWAY_B, 1n)];
    const client = build(pairs, { [`${a}:1`]: false, [`${b}:1`]: true });
    const out = await retrieveReviews(
      cfg(client, { reviewGateway: GATEWAY_B, gateways: [{ address: GATEWAY_A, fromBlock: 0n }] }),
      1n,
    );
    const byGateway = Object.fromEntries(out.reviews.map((r) => [r.gateway, r.revoked]));
    expect(byGateway).toEqual({ [a]: false, [b]: true });
  });

  it('does not double-count a gateway listed twice', async () => {
    const pairs = [pair(GATEWAY_A, 1n)];
    const client = build(pairs, { [`${a}:1`]: false });
    const out = await retrieveReviews(
      cfg(client, {
        gateways: [
          { address: GATEWAY_A, fromBlock: 0n },
          { address: GATEWAY_A.toLowerCase(), fromBlock: 3n },
        ],
      }),
      1n,
    );
    expect(out.reviews).toHaveLength(1);
    expect(out.unattributable).toEqual([]);
  });

  it('counts a human who appears on two gateways once, earliest first', async () => {
    const shared = '0xsharedhuman';
    const pairs = [
      pair(GATEWAY_A, 1n, { nullifier: shared, block: 10n }),
      pair(GATEWAY_B, 1n, { nullifier: shared, block: 20n }),
    ];
    const client = build(pairs, { [`${a}:1`]: false, [`${b}:1`]: false });
    const out = await retrieveReviews(
      cfg(client, { reviewGateway: GATEWAY_B, gateways: [{ address: GATEWAY_A, fromBlock: 0n }] }),
      1n,
    );
    const scored = computeReputation(out.reviews);
    expect(out.reviews).toHaveLength(2);
    expect(scored.distinctHumans).toBe(1);
    expect(scored.excluded).toContainEqual(
      expect.objectContaining({ reason: 'duplicate_nullifier' }),
    );
    expect(scored.eligible[0]?.gateway).toBe(a);
  });

  it('counts a wallet on two gateways once', async () => {
    const reviewer = addr(31337);
    const pairs = [
      pair(GATEWAY_A, 1n, { reviewType: 2, reviewer, block: 10n }),
      pair(GATEWAY_B, 1n, { reviewType: 2, reviewer, block: 20n }),
    ];
    const client = build(pairs, { [`${a}:1`]: false, [`${b}:1`]: false });
    const out = await retrieveReviews(
      cfg(client, { reviewGateway: GATEWAY_B, gateways: [{ address: GATEWAY_A, fromBlock: 0n }] }),
      1n,
    );
    expect(computeReputation(out.reviews).tiers.wallet.count).toBe(1);
  });
});

/* ------------------------------------------------------------------------ */
/* Evidence                                                                  */
/* ------------------------------------------------------------------------ */

const CONTRACTS = {
  reviewGateway: GATEWAY_A,
  receiptSettler: SETTLER,
  identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  reputationRegistry: REGISTRY,
} as const;

function manifestOf(reviews: ReviewInput[]) {
  return buildManifest({
    agentId: 1n,
    chainId: 11155111,
    snapshotBlock: 100n,
    contracts: CONTRACTS,
    result: computeReputation(reviews),
  });
}

describe('evidence manifest v1.1', () => {
  it('is versioned 1.1', () => {
    expect(SPEC_VERSION).toBe('receipts-reputation/1.1');
    expect(manifestOf(fiveHumans()).spec).toBe('receipts-reputation/1.1');
  });

  it('lists wallet records as informational, outside eligibility', () => {
    const m = manifestOf([...fiveHumans(), wallet(70n), wallet(80n)]);
    expect(m.wallet.status).toBe('informational');
    expect(m.wallet.count).toBe(2);
    expect(m.wallet.records).toHaveLength(2);
    expect(m.eligible).toHaveLength(5);
    expect(m.distinctHumans).toBe(5);
    expect(m.totalWeight).toBe('5000000');
    expect(m.score).toBe('30');
  });

  it('records the legacy fields exactly and the tiers beside them', () => {
    const m = manifestOf(fiveHumans());
    expect(m.tiers.human.score).toBe(m.score);
    expect(m.tiers.receipt.status).toBe('no_eligible_reviews');
  });

  it('hashes deterministically and differs when wallet evidence differs', () => {
    const base = fiveHumans();
    const w1 = wallet(70n);
    expect(manifestHash(manifestOf([...base, w1]))).toBe(manifestHash(manifestOf([w1, ...base])));
    expect(manifestHash(manifestOf(base))).not.toBe(manifestHash(manifestOf([...base, w1])));
  });
});

/* ------------------------------------------------------------------------ */
/* Routes                                                                    */
/* ------------------------------------------------------------------------ */

describe('GET /api/agents/:id/reputation', () => {
  async function fetchRep(pairs: ReturnType<typeof pair>[], revoked: Record<string, boolean>) {
    const app = reputationRoute({
      client: build(pairs, revoked),
      chainId: 11155111,
      contracts: CONTRACTS,
      gatewayDeployBlock: 0n,
    });
    const res = await app.request('/api/agents/1/reputation');
    return (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  it('keeps every legacy field and adds tiers', async () => {
    const a = GATEWAY_A.toLowerCase();
    const pairs = [
      ...[1n, 2n, 3n, 4n, 5n].map((i) => pair(GATEWAY_A, i)),
      ...[6n, 7n, 8n].map((i) => pair(GATEWAY_A, i, { reviewType: 2 })),
    ];
    const revoked = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((i) => [`${a}:${i}`, false]));
    const body = await fetchRep(pairs, revoked);

    for (const key of [
      'agent_id',
      'status',
      'score',
      'threshold',
      'distinct_humans',
      'human_verified',
      'receipt_verified',
      'total_weight',
      'snapshot_block',
      'evidence_hash',
      'evidence',
      'unattributable',
    ]) {
      expect(body).toHaveProperty(key);
    }
    expect(body['distinct_humans']).toBe(5);
    expect(body['human_verified']).toBe(5);
    expect(body['total_weight']).toBe('5000000');
    expect(body['tiers'].human).toEqual({
      score: 50,
      count: 5,
      threshold: 5,
      status: 'published',
      totalWeight: '5000000',
    });
    expect(body['tiers'].receipt.status).toBe('no_eligible_reviews');
    expect(body['tiers'].wallet).toEqual({
      score: null,
      count: 3,
      threshold: 0,
      status: 'informational',
      totalWeight: '0',
    });
    expect(body['score']).toBe(body['tiers'].human.score);
  });
});

describe('POST /api/reputation/simulate', () => {
  async function simulate(reviews: unknown[]) {
    const res = await reputationSimulateRoute().request('/api/reputation/simulate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviews }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  it('shows wallet reviews cannot move the human score', async () => {
    const humans = [10, 20, 30, 40, 50].map((value) => ({ value, reviewType: 0 }));
    const wallets = Array.from({ length: 30 }, () => ({ value: 100, reviewType: 2 }));
    const { status, body } = await simulate([...humans, ...wallets]);
    expect(status).toBe(200);
    expect(body['score']).toBe(30);
    expect(body['tiers'].wallet.count).toBe(30);
    expect(body['wallet_effect']).toEqual({
      wallet_reviews: 30,
      human_score_with_wallet: 30,
      human_score_without_wallet: 30,
      unchanged: true,
    });
  });

  it('distinguishes human, paid-human and wallet-only reviews', async () => {
    const { body } = await simulate([
      ...[10, 20, 30, 40, 50].map((value) => ({ value, reviewType: 1, paymentAmount: '10000000' })),
      { value: 99, reviewType: 0 },
      { value: 1, reviewType: 2 },
    ]);
    expect(body['tiers'].human.count).toBe(6);
    expect(body['tiers'].receipt.count).toBe(5);
    expect(body['tiers'].wallet.count).toBe(1);
  });

  it('shows wallet-only reviews produce no score', async () => {
    const { body } = await simulate(
      Array.from({ length: 10 }, () => ({ value: 95, reviewType: 2 })),
    );
    expect(body['score']).toBeNull();
    expect(body['status']).toBe('no_eligible_reviews');
  });

  it('still rejects unknown review types', async () => {
    const { status } = await simulate([{ value: 50, reviewType: 3 }]);
    expect(status).toBe(400);
  });
});

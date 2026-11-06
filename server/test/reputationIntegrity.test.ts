import { describe, expect, it } from 'vitest';
import { computeReputation, normalizeNullifier } from '../src/reputation/engine.js';
import type { ReviewInput } from '../src/reputation/engine.js';
import { buildManifest, manifestHash } from '../src/reputation/evidence.js';
import { retrieveReviews, RetrievalIntegrityError } from '../src/reputation/retrieval.js';
import { FREE_WEIGHT } from '../src/reputation/spec.js';

/**
 * Regressions for the v1.0 correctness pass.
 *
 * Each block names the failure mode it prevents, because every one of these
 * is a case where the previous implementation produced a confident number
 * from incomplete evidence.
 */

const GATEWAY = '0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD' as const;
const SETTLER = '0xC3AA7a2F43d83680f9E0B97e0Eb4fD01E421ceDe' as const;
const REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713' as const;
const REVIEWER = '0x000000000000000000000000000000000000bEEF' as const;
const ZERO32 = `0x${'00'.repeat(32)}`;

let seq = 0;
function review(partial: Partial<ReviewInput> & { value: bigint }): ReviewInput {
  seq += 1;
  return {
    nullifier: partial.nullifier ?? `0xn${seq}`,
    reviewer: partial.reviewer ?? `0x${seq.toString(16).padStart(40, '0')}`,
    value: partial.value,
    valueDecimals: partial.valueDecimals ?? 0,
    reviewType: partial.reviewType ?? 0,
    paymentAmount: partial.paymentAmount,
    revoked: partial.revoked ?? false,
    feedbackIndex: partial.feedbackIndex ?? BigInt(seq),
    blockNumber: partial.blockNumber ?? BigInt(seq),
    logIndex: partial.logIndex ?? 0,
  };
}

/* ------------------------------------------------------------------------ */
/* 3. Duplicate nullifiers                                                   */
/* ------------------------------------------------------------------------ */

describe('duplicate nullifiers', () => {
  it('treats differently-cased nullifiers as one human', () => {
    const result = computeReputation([
      review({ value: 10n, nullifier: '0xABCDEF', blockNumber: 1n }),
      review({ value: 90n, nullifier: '0xabcdef', blockNumber: 2n }),
      ...[20, 30, 40, 50].map((v, i) =>
        review({ value: BigInt(v), nullifier: `0xo${i}`, blockNumber: BigInt(10 + i) }),
      ),
    ]);
    expect(result.distinctHumans).toBe(5);
    expect(result.excluded).toContainEqual(
      expect.objectContaining({ reason: 'duplicate_nullifier', nullifier: '0xabcdef' }),
    );
  });

  it('normalises the nullifier it reports, not the spelling it received', () => {
    const result = computeReputation([review({ value: 10n, nullifier: '0xAbCd' })]);
    expect(result.eligible[0]?.nullifier).toBe('0xabcd');
    expect(normalizeNullifier('  0xAbCd ')).toBe('0xabcd');
  });

  it('keeps the EARLIEST entry even when that entry is later excluded', () => {
    // The revoke-and-resubmit attack. A human's first review is revoked; a
    // second, higher one follows. If deduplication ran after classification
    // the revoked entry would vanish and the replacement would vote, letting
    // one nullifier be re-used at will.
    const attacker = [
      review({ value: 10n, nullifier: '0xdupe', blockNumber: 1n, revoked: true }),
      review({ value: 100n, nullifier: '0xdupe', blockNumber: 2n }),
    ];
    const honest = [20, 30, 40, 50, 60].map((v, i) =>
      review({ value: BigInt(v), nullifier: `0xh${i}`, blockNumber: BigInt(10 + i) }),
    );

    const result = computeReputation([...attacker, ...honest]);

    // The nullifier contributes nothing: its only usable entry is revoked.
    expect(result.eligible.some((e) => e.nullifier === '0xdupe')).toBe(false);
    expect(result.distinctHumans).toBe(5);
    expect(result.excluded).toContainEqual(
      expect.objectContaining({ nullifier: '0xdupe', reason: 'duplicate_nullifier' }),
    );
    expect(result.excluded).toContainEqual(
      expect.objectContaining({ nullifier: '0xdupe', reason: 'revoked' }),
    );
    // The 100 never enters the median.
    expect(result.score).toBe(40n);
  });

  it('is independent of the order duplicates arrive in', () => {
    const early = review({ value: 10n, nullifier: '0xsame', blockNumber: 5n, logIndex: 1 });
    const late = review({ value: 90n, nullifier: '0xsame', blockNumber: 5n, logIndex: 2 });
    const rest = [20, 30, 40, 50].map((v, i) =>
      review({ value: BigInt(v), nullifier: `0xr${i}`, blockNumber: BigInt(20 + i) }),
    );
    const a = computeReputation([early, late, ...rest]);
    const b = computeReputation([late, early, ...rest]);
    expect(a.eligible.find((e) => e.nullifier === '0xsame')?.value).toBe(10n);
    expect(b.eligible.find((e) => e.nullifier === '0xsame')?.value).toBe(10n);
    expect(a.score).toBe(b.score);
  });
});

/* ------------------------------------------------------------------------ */
/* 6. Evidence accounts for unattributable records                           */
/* ------------------------------------------------------------------------ */

describe('evidence integrity', () => {
  const SET = [10, 20, 30, 40, 50].map((v, i) =>
    review({ value: BigInt(v), nullifier: `0xe${i}`, blockNumber: BigInt(i + 1) }),
  );
  const CONTRACTS = {
    reviewGateway: GATEWAY,
    receiptSettler: SETTLER,
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputationRegistry: REGISTRY,
  } as const;

  const manifest = (unattributable: readonly { detail: string }[] = []) =>
    buildManifest({
      agentId: 1n,
      chainId: 11155111,
      snapshotBlock: 100n,
      contracts: CONTRACTS,
      result: computeReputation(SET),
      unattributable,
    });

  it('records unattributable entries with their reasons', () => {
    const m = manifest([{ detail: 'tx 0xabc: feedbackHash mismatch' }]);
    expect(m.unattributable).toEqual([{ detail: 'tx 0xabc: feedbackHash mismatch' }]);
  });

  it('changes the evidence hash when a record becomes unattributable', () => {
    // The score is identical; the claim behind it is not, and the hash must
    // say so. Otherwise a run that silently dropped three entries is
    // indistinguishable from a clean one.
    const clean = manifest([]);
    const degraded = manifest([{ detail: 'tx 0xabc: NewFeedback with no ReviewSubmitted' }]);
    expect(clean.score).toBe(degraded.score);
    expect(manifestHash(clean)).not.toBe(manifestHash(degraded));
  });

  it('hashes unattributable records independently of their discovery order', () => {
    const a = manifest([{ detail: 'b problem' }, { detail: 'a problem' }]);
    const b = manifest([{ detail: 'a problem' }, { detail: 'b problem' }]);
    expect(manifestHash(a)).toBe(manifestHash(b));
  });

  it('defaults to an empty list rather than omitting the field', () => {
    expect(manifest().unattributable).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* 1, 2, 5. Retrieval: fail-closed behaviour against a stub chain            */
/* ------------------------------------------------------------------------ */

interface StubOptions {
  readonly feedback?: unknown[];
  readonly reviews?: unknown[];
  readonly readAllFeedback?: unknown;
  readonly readAllFeedbackThrows?: boolean;
  readonly receipts?: Record<string, unknown[]>;
}

/** Minimal PublicClient double: only the four methods retrieval calls. */
function stubClient(options: StubOptions) {
  return {
    getBlockNumber: async () => 200n,
    getContractEvents: async ({ eventName }: { eventName: string }) =>
      eventName === 'NewFeedback' ? (options.feedback ?? []) : (options.reviews ?? []),
    readContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args: readonly unknown[];
    }) => {
      if (functionName === 'readAllFeedback') {
        if (options.readAllFeedbackThrows === true) throw new Error('rpc down');
        return options.readAllFeedback ?? [[], [], [], [], [], [], []];
      }
      const id = String(args[0]);
      const receipt = options.receipts?.[id];
      if (receipt === undefined) throw new Error('no such receipt');
      return receipt;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const config = (client: unknown) =>
  ({
    client,
    reviewGateway: GATEWAY,
    receiptSettler: SETTLER,
    reputationRegistry: REGISTRY,
    fromBlock: 0n,
    maxLogRange: 1_000n,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

function feedbackLog(over: Record<string, unknown> = {}) {
  return {
    transactionHash: '0xtx1',
    blockNumber: 10n,
    logIndex: 0,
    args: {
      feedbackIndex: 1n,
      value: 50n,
      valueDecimals: 0,
      tag1: 'quality',
      tag2: 'human-verified',
      feedbackHash: '0xhash1',
      ...over,
    },
  };
}

function reviewLog(over: Record<string, unknown> = {}) {
  return {
    transactionHash: '0xtx1',
    blockNumber: 10n,
    logIndex: 1,
    args: {
      nullifier: '0xnull1',
      reviewer: REVIEWER,
      reviewType: 0,
      receiptId: ZERO32,
      feedbackHash: '0xhash1',
      ...over,
    },
  };
}

/** readAllFeedback shape: seven parallel arrays. */
function feedbackTable(indexes: bigint[], revoked: boolean[]) {
  const n = indexes.length;
  return [
    Array.from({ length: n }, () => GATEWAY),
    indexes,
    Array.from({ length: n }, () => 50n),
    Array.from({ length: n }, () => 0),
    Array.from({ length: n }, () => 'quality'),
    Array.from({ length: n }, () => 'human-verified'),
    revoked,
  ];
}

describe('revocation integrity', () => {
  it('admits a review whose index has an explicit status', async () => {
    const out = await retrieveReviews(
      config(
        stubClient({
          feedback: [feedbackLog()],
          reviews: [reviewLog()],
          readAllFeedback: feedbackTable([1n], [false]),
        }),
      ),
      1n,
    );
    expect(out.reviews).toHaveLength(1);
    expect(out.reviews[0]?.revoked).toBe(false);
  });

  it('carries a true revocation status through rather than dropping it', async () => {
    const out = await retrieveReviews(
      config(
        stubClient({
          feedback: [feedbackLog()],
          reviews: [reviewLog()],
          readAllFeedback: feedbackTable([1n], [true]),
        }),
      ),
      1n,
    );
    expect(out.reviews[0]?.revoked).toBe(true);
  });

  it('refuses to assume "not revoked" for an index with no status', async () => {
    // The table knows about index 2; the candidate is index 1. Previously
    // this defaulted to false and the review scored.
    const out = await retrieveReviews(
      config(
        stubClient({
          feedback: [feedbackLog({ feedbackIndex: 1n })],
          reviews: [reviewLog()],
          readAllFeedback: feedbackTable([2n], [false]),
        }),
      ),
      1n,
    );
    expect(out.reviews).toHaveLength(0);
    expect(out.unattributable.map((u) => u.detail).join()).toMatch(/no revocation status/);
  });

  it('fails closed when the registry cannot be read at all', async () => {
    await expect(
      retrieveReviews(config(stubClient({ readAllFeedbackThrows: true })), 1n),
    ).rejects.toBeInstanceOf(RetrievalIntegrityError);
  });

  it('rejects ragged arrays from readAllFeedback', async () => {
    // Six statuses for seven indexes: index i is not meaningful everywhere.
    const ragged = feedbackTable([1n, 2n], [false]);
    await expect(
      retrieveReviews(config(stubClient({ readAllFeedback: ragged })), 1n),
    ).rejects.toThrow(/ragged/);
  });
});

describe('ambiguous event joins', () => {
  it('rejects every event from a tx with two ReviewSubmitted', async () => {
    const out = await retrieveReviews(
      config(
        stubClient({
          feedback: [feedbackLog()],
          reviews: [reviewLog(), reviewLog({ nullifier: '0xnull2' })],
          readAllFeedback: feedbackTable([1n], [false]),
        }),
      ),
      1n,
    );
    // Not "keep the first": neither is trusted.
    expect(out.reviews).toHaveLength(0);
    expect(out.unattributable.map((u) => u.detail).join()).toMatch(
      /2 ReviewSubmitted events, expected 1/,
    );
  });

  it('rejects every event from a tx with two NewFeedback', async () => {
    const out = await retrieveReviews(
      config(
        stubClient({
          feedback: [feedbackLog(), feedbackLog({ feedbackIndex: 2n })],
          reviews: [reviewLog()],
          readAllFeedback: feedbackTable([1n, 2n], [false, false]),
        }),
      ),
      1n,
    );
    expect(out.reviews).toHaveLength(0);
    expect(out.unattributable.map((u) => u.detail).join()).toMatch(
      /2 NewFeedback events, expected 1/,
    );
  });

  it('reports unmatched events on both sides', async () => {
    const out = await retrieveReviews(
      config(
        stubClient({
          feedback: [feedbackLog({}), { ...feedbackLog(), transactionHash: '0xonlyFeedback' }],
          reviews: [reviewLog({}), { ...reviewLog(), transactionHash: '0xonlyReview' }],
          readAllFeedback: feedbackTable([1n], [false]),
        }),
      ),
      1n,
    );
    const details = out.unattributable.map((u) => u.detail).join('\n');
    expect(details).toMatch(/0xonlyFeedback: NewFeedback with no ReviewSubmitted/);
    expect(details).toMatch(/0xonlyReview: ReviewSubmitted with no NewFeedback/);
  });

  it('requires an exact feedbackHash match within the transaction', async () => {
    const out = await retrieveReviews(
      config(
        stubClient({
          feedback: [feedbackLog({ feedbackHash: '0xhashA' })],
          reviews: [reviewLog({ feedbackHash: '0xhashB' })],
          readAllFeedback: feedbackTable([1n], [false]),
        }),
      ),
      1n,
    );
    expect(out.reviews).toHaveLength(0);
    expect(out.unattributable.map((u) => u.detail).join()).toMatch(/feedbackHash mismatch/);
  });
});

describe('receipt integrity', () => {
  const paidFeedback = feedbackLog({ tag2: 'receipt-verified' });
  const paidReview = (over: Record<string, unknown> = {}) =>
    reviewLog({ reviewType: 1, receiptId: '0xreceipt1', ...over });

  const goodReceipt = [REVIEWER, 1n, 5_000_000n, 0n, true, ZERO32];

  it('accepts a receipt that matches payer, agent and spent state', async () => {
    const out = await retrieveReviews(
      config(
        stubClient({
          feedback: [paidFeedback],
          reviews: [paidReview()],
          readAllFeedback: feedbackTable([1n], [false]),
          receipts: { '0xreceipt1': goodReceipt },
        }),
      ),
      1n,
    );
    expect(out.reviews[0]?.paymentAmount).toBe(5_000_000n);
  });

  it('refuses a receipt cited by more than one review', async () => {
    const out = await retrieveReviews(
      config(
        stubClient({
          feedback: [
            paidFeedback,
            {
              ...paidFeedback,
              transactionHash: '0xtx2',
              args: { ...paidFeedback.args, feedbackIndex: 2n, feedbackHash: '0xhash2' },
            },
          ],
          reviews: [
            paidReview(),
            {
              ...paidReview({ nullifier: '0xnull2', feedbackHash: '0xhash2' }),
              transactionHash: '0xtx2',
            },
          ],
          readAllFeedback: feedbackTable([1n, 2n], [false, false]),
          receipts: { '0xreceipt1': goodReceipt },
        }),
      ),
      1n,
    );
    // Both reviews survive as records, but neither gets payment weight, and
    // the engine then excludes both as missing_payment.
    expect(out.reviews.every((r) => r.paymentAmount === undefined)).toBe(true);
    expect(out.unattributable.map((u) => u.detail).join()).toMatch(/cited by 2 reviews/);

    const scored = computeReputation(out.reviews);
    expect(scored.excluded.filter((e) => e.reason === 'missing_payment')).toHaveLength(2);
  });

  it('rejects a free review that carries a non-zero receipt id', async () => {
    const out = await retrieveReviews(
      config(
        stubClient({
          feedback: [feedbackLog()],
          reviews: [reviewLog({ reviewType: 0, receiptId: '0xreceipt1' })],
          readAllFeedback: feedbackTable([1n], [false]),
          receipts: { '0xreceipt1': goodReceipt },
        }),
      ),
      1n,
    );
    expect(out.reviews).toHaveLength(0);
    expect(out.unattributable.map((u) => u.detail).join()).toMatch(
      /free review carries a receipt id/,
    );
  });

  it('rejects a paid review with the zero receipt id', async () => {
    const out = await retrieveReviews(
      config(
        stubClient({
          feedback: [paidFeedback],
          reviews: [reviewLog({ reviewType: 1, receiptId: ZERO32 })],
          readAllFeedback: feedbackTable([1n], [false]),
        }),
      ),
      1n,
    );
    expect(out.reviews).toHaveLength(0);
    expect(out.unattributable.map((u) => u.detail).join()).toMatch(
      /paid review carries no receipt id/,
    );
  });

  it('assigns no weight when payer, agent or spent state disagree', async () => {
    const cases: Record<string, unknown[]> = {
      wrongPayer: ['0x0000000000000000000000000000000000001234', 1n, 5_000_000n, 0n, true, ZERO32],
      wrongAgent: [REVIEWER, 99n, 5_000_000n, 0n, true, ZERO32],
      notSpent: [REVIEWER, 1n, 5_000_000n, 0n, false, ZERO32],
    };
    for (const [label, receipt] of Object.entries(cases)) {
      const out = await retrieveReviews(
        config(
          stubClient({
            feedback: [paidFeedback],
            reviews: [paidReview()],
            readAllFeedback: feedbackTable([1n], [false]),
            receipts: { '0xreceipt1': receipt },
          }),
        ),
        1n,
      );
      expect(out.reviews[0]?.paymentAmount, label).toBeUndefined();
      expect(out.unattributable.map((u) => u.detail).join(), label).toMatch(/does not match/);
    }
  });

  it('never substitutes the free weight for unverifiable paid evidence', async () => {
    const out = await retrieveReviews(
      config(
        stubClient({
          feedback: [paidFeedback],
          reviews: [paidReview()],
          readAllFeedback: feedbackTable([1n], [false]),
          receipts: {}, // unreadable
        }),
      ),
      1n,
    );
    expect(out.reviews[0]?.paymentAmount).toBeUndefined();
    const scored = computeReputation(out.reviews);
    expect(scored.eligible).toHaveLength(0);
    expect(scored.excluded[0]?.reason).toBe('missing_payment');
    // Specifically NOT weighted as an ordinary free review.
    expect(scored.totalWeight).not.toBe(FREE_WEIGHT);
  });
});

describe('snapshot pinning', () => {
  it('pins the snapshot below the head when confirmations are requested', async () => {
    const out = await retrieveReviews({ ...config(stubClient({})), confirmations: 12n }, 1n);
    expect(out.snapshotBlock).toBe(188n); // head 200 - 12
  });

  it('does not go below genesis when the chain is shorter than the lag', async () => {
    const out = await retrieveReviews({ ...config(stubClient({})), confirmations: 10_000n }, 1n);
    expect(out.snapshotBlock).toBe(0n);
  });
});

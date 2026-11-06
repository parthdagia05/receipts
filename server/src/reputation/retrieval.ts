import { getAddress } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import {
  REVIEW_TYPE_FREE,
  REVIEW_TYPE_PAID,
  REVIEW_TYPE_WALLET,
  TAG1_QUALITY,
  TAG2_FREE,
  TAG2_PAID,
  TAG2_WALLET,
} from './spec.js';
import { normalizeNullifier } from './engine.js';
import type { ReviewInput } from './engine.js';

/**
 * Chain reads for the reputation engine.
 *
 * Separate from `engine.ts` on purpose: this file is the only part that can
 * be wrong because a node lied or an event moved, and the calculation stays
 * testable without a chain.
 *
 * The join between an ERC-8004 feedback entry and a Receipts review is the
 * crux. Verified empirically against the deployed Sepolia registry rather
 * than taken from documentation:
 *
 *   NewFeedback(uint256,address,uint64,int128,uint8,
 *               string,string,string,string,string,bytes32)
 *   topic0 0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc
 *
 * It carries feedbackIndex, value, valueDecimals, tag1, tag2 and feedbackHash;
 * `ReviewSubmitted` carries nullifier, reviewer, reviewType and receiptId. The
 * gateway emits both inside one transaction and emits exactly one of each per
 * review, so the pair is matched on transaction hash and then cross-checked on
 * feedbackHash. A pair that disagrees on feedbackHash is dropped rather than
 * guessed at.
 */

/** Verified against the deployed registry; see the note above. */
export const newFeedbackAbi = [
  {
    type: 'event',
    name: 'NewFeedback',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'clientAddress', type: 'address', indexed: true },
      { name: 'feedbackIndex', type: 'uint64', indexed: false },
      { name: 'value', type: 'int128', indexed: false },
      { name: 'valueDecimals', type: 'uint8', indexed: false },
      { name: 'indexedTag1', type: 'string', indexed: true },
      { name: 'tag1', type: 'string', indexed: false },
      { name: 'tag2', type: 'string', indexed: false },
      { name: 'endpoint', type: 'string', indexed: false },
      { name: 'feedbackURI', type: 'string', indexed: false },
      { name: 'feedbackHash', type: 'bytes32', indexed: false },
    ],
  },
] as const;

export const reviewSubmittedAbi = [
  {
    type: 'event',
    name: 'ReviewSubmitted',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'reviewer', type: 'address', indexed: true },
      { name: 'nullifier', type: 'bytes32', indexed: true },
      { name: 'reviewType', type: 'uint8', indexed: false },
      { name: 'receiptId', type: 'bytes32', indexed: false },
      { name: 'feedbackHash', type: 'bytes32', indexed: false },
    ],
  },
] as const;

export const readAllFeedbackAbi = [
  {
    type: 'function',
    name: 'readAllFeedback',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'includeRevoked', type: 'bool' },
    ],
    outputs: [
      { name: 'clients', type: 'address[]' },
      { name: 'feedbackIndexes', type: 'uint64[]' },
      { name: 'values', type: 'int128[]' },
      { name: 'valueDecimals', type: 'uint8[]' },
      { name: 'tag1s', type: 'string[]' },
      { name: 'tag2s', type: 'string[]' },
      { name: 'revokedStatuses', type: 'bool[]' },
    ],
  },
] as const;

export const receiptsAbi = [
  {
    type: 'function',
    name: 'receipts',
    stateMutability: 'view',
    inputs: [{ name: 'receiptId', type: 'bytes32' }],
    outputs: [
      { name: 'payer', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'settledAt', type: 'uint64' },
      { name: 'spent', type: 'bool' },
      { name: 'orderId', type: 'bytes32' },
    ],
  },
] as const;

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as Hex;

/** One gateway deployment whose history counts. */
export interface GatewaySource {
  readonly address: Address;
  /** First block worth scanning for this gateway. */
  readonly fromBlock: bigint;
}

/**
 * The only (reviewType, tag2, receipt) combinations that attribute.
 *
 * Anything else, including a type this engine does not know, is reported as
 * unattributable instead of being read as a human review. Previously every
 * non-paid type was treated as free, which would have let a wallet entry pass
 * as human-verified.
 */
const REVIEW_TYPE_RULES: Record<number, { tag2: string; receipt: boolean }> = {
  [REVIEW_TYPE_FREE]: { tag2: TAG2_FREE, receipt: false },
  [REVIEW_TYPE_PAID]: { tag2: TAG2_PAID, receipt: true },
  [REVIEW_TYPE_WALLET]: { tag2: TAG2_WALLET, receipt: false },
};

export interface RetrievalConfig {
  readonly client: PublicClient;
  /** The current gateway. Always scanned; see `gateways` for earlier ones. */
  readonly reviewGateway: Address;
  readonly receiptSettler: Address;
  readonly reputationRegistry: Address;
  /** First block worth scanning; `reviewGateway`'s deployment block. */
  readonly fromBlock: bigint;
  /**
   * Additional gateways whose reviews still count, each with its own
   * deployment block. A replacement gateway must not erase the history of the
   * one it replaced, so every gateway listed here is scanned alongside
   * `reviewGateway`. Duplicate addresses are merged (earliest block wins) so
   * one gateway can never be scanned, and counted, twice.
   */
  readonly gateways?: readonly GatewaySource[];
  /** Largest span a single eth_getLogs may cover on this endpoint. */
  readonly maxLogRange?: bigint;
  /**
   * Blocks to stay behind the head. Zero by default: a testnet demo wants
   * the review it just submitted to appear. Raise it to trade freshness for
   * a snapshot that is unlikely to be reorged out. See the finality note in
   * `evidence.ts`.
   */
  readonly confirmations?: bigint;
}

export interface RetrievalResult {
  readonly reviews: readonly ReviewInput[];
  readonly snapshotBlock: bigint;
  /** Pairs seen on chain that could not be attributed, with the reason. */
  readonly unattributable: readonly { readonly detail: string }[];
}

// 9,999 keeps every window inside the 10,000-block eth_getLogs cap that
// keyless public endpoints commonly enforce, the tightest practical limit
// among the endpoints a deployment realistically uses.
const DEFAULT_MAX_LOG_RANGE = 9_999n;

/** Raised when the snapshot cannot be established well enough to score. */
export class RetrievalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetrievalIntegrityError';
  }
}

/**
 * Collect every Receipts review for one agent, at a single snapshot block.
 *
 * Fails closed throughout. Where the chain cannot be read well enough to
 * decide whether a review counts, this throws or marks the review
 * unattributable; it never falls back to a value that would let the review
 * score. A missing answer and a negative answer are not the same thing, and
 * conflating them is how an incomplete read becomes a confident number.
 *
 * Every read is pinned to `snapshotBlock`: the log scan ends there, and both
 * contract reads pass it explicitly. Mixing a log from one block with state
 * from another would produce a manifest describing no actual chain state.
 */
export async function retrieveReviews(
  config: RetrievalConfig,
  agentId: bigint,
): Promise<RetrievalResult> {
  const { client } = config;
  const head = await client.getBlockNumber();
  const lag = config.confirmations ?? 0n;
  const snapshotBlock = head > lag ? head - lag : 0n;
  const maxRange = config.maxLogRange ?? DEFAULT_MAX_LOG_RANGE;
  const unattributable: { detail: string }[] = [];

  // --- 0. The set of gateways whose history counts ------------------------
  //
  // One entry per distinct address. A repeated address is merged rather than
  // scanned twice, keeping the earliest block, so a misconfigured list cannot
  // double every review.
  const gatewayByKey = new Map<string, GatewaySource>();
  for (const source of [
    { address: config.reviewGateway, fromBlock: config.fromBlock },
    ...(config.gateways ?? []),
  ]) {
    const key = source.address.toLowerCase();
    const existing = gatewayByKey.get(key);
    if (existing === undefined || source.fromBlock < existing.fromBlock) {
      gatewayByKey.set(key, { address: source.address, fromBlock: source.fromBlock });
    }
  }
  const gateways = [...gatewayByKey.values()];

  // --- 1. Both event streams, over the same window, per gateway -----------
  const feedbackLogs = [];
  const reviewLogs = [];
  // Which gateway each log was fetched for. Attribution comes from the query,
  // which is filtered by gateway address, not from a field of the log.
  const gatewayOfLog = new WeakMap<object, string>();

  for (const gateway of gateways) {
    for (let from = gateway.fromBlock; from <= snapshotBlock; from += maxRange) {
      const to = from + maxRange - 1n > snapshotBlock ? snapshotBlock : from + maxRange - 1n;

      const feedbackBatch = await client.getContractEvents({
        address: config.reputationRegistry,
        abi: newFeedbackAbi,
        eventName: 'NewFeedback',
        // Scoped to this agent AND to feedback this gateway authored, so no
        // other client's entries can enter a Receipts score.
        args: { agentId, clientAddress: gateway.address },
        fromBlock: from,
        toBlock: to,
      });
      for (const log of feedbackBatch) gatewayOfLog.set(log, gateway.address.toLowerCase());
      feedbackLogs.push(...feedbackBatch);

      const reviewBatch = await client.getContractEvents({
        address: gateway.address,
        abi: reviewSubmittedAbi,
        eventName: 'ReviewSubmitted',
        args: { agentId },
        fromBlock: from,
        toBlock: to,
      });
      for (const log of reviewBatch) gatewayOfLog.set(log, gateway.address.toLowerCase());
      reviewLogs.push(...reviewBatch);
    }
  }

  // --- 2. Reject ambiguous transactions on BOTH sides ---------------------
  //
  // The gateway emits exactly one of each event per review, inside one
  // transaction. Two of either kind in one transaction means something
  // batched them, and which feedback entry belongs to which review would be
  // a guess. Every event from such a transaction is dropped -- keeping the
  // first would be choosing an answer rather than admitting there isn't one.
  const countByTx = (logs: readonly { transactionHash: string }[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const log of logs)
      counts.set(log.transactionHash, (counts.get(log.transactionHash) ?? 0) + 1);
    return counts;
  };

  const feedbackCounts = countByTx(feedbackLogs);
  const reviewCounts = countByTx(reviewLogs);
  const ambiguousTxs = new Set<string>();

  for (const [tx, count] of feedbackCounts) {
    if (count > 1) {
      ambiguousTxs.add(tx);
      unattributable.push({ detail: `tx ${tx}: ${count} NewFeedback events, expected 1` });
    }
  }
  for (const [tx, count] of reviewCounts) {
    if (count > 1) {
      ambiguousTxs.add(tx);
      unattributable.push({ detail: `tx ${tx}: ${count} ReviewSubmitted events, expected 1` });
    }
  }

  // Unmatched on either side, reported in both directions.
  for (const tx of feedbackCounts.keys()) {
    if (!reviewCounts.has(tx)) {
      unattributable.push({ detail: `tx ${tx}: NewFeedback with no ReviewSubmitted` });
    }
  }
  for (const tx of reviewCounts.keys()) {
    if (!feedbackCounts.has(tx)) {
      unattributable.push({ detail: `tx ${tx}: ReviewSubmitted with no NewFeedback` });
    }
  }

  const reviewByTx = new Map<string, (typeof reviewLogs)[number]>();
  for (const log of reviewLogs) {
    if (ambiguousTxs.has(log.transactionHash)) continue;
    reviewByTx.set(log.transactionHash, log);
  }

  const usableFeedback = feedbackLogs.filter((log) => !ambiguousTxs.has(log.transactionHash));

  // --- 3. Revocation state, pinned and complete ---------------------------
  //
  // Required for every candidate. An index with no explicit status is not
  // assumed live: that default would score an entry the registry may have
  // revoked, which is the one direction the error must not run in.
  //
  // Keyed by gateway AND index: ERC-8004 numbers feedback per (agent, client),
  // so two gateways both have a feedback index 1.
  const revokedByIndex = new Map<string, boolean>();
  for (const gateway of gateways) {
    try {
      const [clients, feedbackIndexes, values, valueDecimals, tag1s, tag2s, revokedStatuses] =
        await client.readContract({
          address: config.reputationRegistry,
          abi: readAllFeedbackAbi,
          functionName: 'readAllFeedback',
          args: [agentId, [gateway.address], TAG1_QUALITY, '', true],
          blockNumber: snapshotBlock,
        });

      // The registry returns seven parallel arrays. Index i is only meaningful
      // if every one of them has an element there.
      const lengths = [
        clients.length,
        feedbackIndexes.length,
        values.length,
        valueDecimals.length,
        tag1s.length,
        tag2s.length,
        revokedStatuses.length,
      ];
      if (new Set(lengths).size !== 1) {
        throw new RetrievalIntegrityError(
          `readAllFeedback returned ragged arrays: ${lengths.join(',')}`,
        );
      }

      feedbackIndexes.forEach((index, i) => {
        const status = revokedStatuses[i];
        if (status === undefined) return;
        revokedByIndex.set(`${gateway.address.toLowerCase()}:${index.toString()}`, status);
      });
    } catch (error) {
      if (error instanceof RetrievalIntegrityError) throw error;
      throw new RetrievalIntegrityError(
        'could not read revocation state from the Reputation Registry',
      );
    }
  }

  // --- 4. Receipts for paid reviews, pinned to the snapshot ---------------
  const receiptIds = new Set<Hex>();
  for (const log of reviewLogs) {
    const id = log.args.receiptId;
    if (id !== undefined && id !== ZERO_BYTES32) receiptIds.add(id);
  }

  const receiptById = new Map<
    string,
    { payer: Address; agentId: bigint; amount: bigint; spent: boolean }
  >();
  for (const receiptId of receiptIds) {
    try {
      const [payer, receiptAgentId, amount, , spent] = await client.readContract({
        address: config.receiptSettler,
        abi: receiptsAbi,
        functionName: 'receipts',
        args: [receiptId],
        blockNumber: snapshotBlock,
      });
      receiptById.set(receiptId, { payer, agentId: receiptAgentId, amount, spent });
    } catch {
      unattributable.push({ detail: `receipt ${receiptId} unreadable` });
    }
  }

  // A receipt is single-use on chain: the settler marks it spent and refuses
  // a second consume. Two reviews citing one receipt therefore cannot both be
  // genuine, and there is no rule for choosing between them, so neither is
  // trusted for payment weight.
  const receiptUseCount = new Map<string, number>();
  for (const log of reviewLogs) {
    const id = log.args.receiptId;
    if (id === undefined || id === ZERO_BYTES32) continue;
    receiptUseCount.set(id, (receiptUseCount.get(id) ?? 0) + 1);
  }
  const reusedReceipts = new Set<string>();
  for (const [id, count] of receiptUseCount) {
    if (count > 1) {
      reusedReceipts.add(id);
      unattributable.push({ detail: `receipt ${id} cited by ${count} reviews` });
    }
  }

  // --- 5. Assemble -------------------------------------------------------
  const reviews: ReviewInput[] = [];

  for (const feedback of usableFeedback) {
    const review = reviewByTx.get(feedback.transactionHash);
    if (review === undefined) continue; // already reported in step 2

    if (
      feedback.args.feedbackHash === undefined ||
      review.args.feedbackHash === undefined ||
      feedback.args.feedbackHash !== review.args.feedbackHash
    ) {
      unattributable.push({ detail: `tx ${feedback.transactionHash}: feedbackHash mismatch` });
      continue;
    }

    const { feedbackIndex, value, valueDecimals, tag1, tag2 } = feedback.args;
    const { nullifier, reviewType, receiptId, reviewer } = review.args;

    // Both halves of a review must have been fetched for the same gateway;
    // otherwise the pair is not a single review.
    const gatewayKey = gatewayOfLog.get(feedback);
    if (gatewayKey === undefined || gatewayOfLog.get(review) !== gatewayKey) {
      unattributable.push({ detail: `tx ${feedback.transactionHash}: gateway mismatch` });
      continue;
    }
    if (
      feedbackIndex === undefined ||
      value === undefined ||
      valueDecimals === undefined ||
      nullifier === undefined ||
      reviewType === undefined ||
      reviewer === undefined
    ) {
      unattributable.push({ detail: `tx ${feedback.transactionHash}: incomplete log pair` });
      continue;
    }

    // The gateway writes these tags unconditionally; a mismatch means the
    // entry did not come from the path this engine is scoring.
    if (tag1 !== TAG1_QUALITY) {
      unattributable.push({ detail: `tx ${feedback.transactionHash}: unexpected tag1` });
      continue;
    }
    // Fail closed on a type this engine does not know, instead of reading it
    // as a human review.
    const rule = REVIEW_TYPE_RULES[reviewType];
    if (rule === undefined) {
      unattributable.push({
        detail: `tx ${feedback.transactionHash}: unknown reviewType ${reviewType}`,
      });
      continue;
    }
    if (tag2 !== rule.tag2) {
      unattributable.push({
        detail: `tx ${feedback.transactionHash}: tag2 contradicts reviewType ${reviewType}`,
      });
      continue;
    }

    // Receipt-id semantics are part of the gateway's contract: a free review
    // must carry the zero id and a paid one must not.
    const hasReceipt = receiptId !== undefined && receiptId !== ZERO_BYTES32;
    if (!rule.receipt && hasReceipt) {
      unattributable.push({
        detail: `tx ${feedback.transactionHash}: ${
          reviewType === REVIEW_TYPE_FREE ? 'free' : 'wallet'
        } review carries a receipt id`,
      });
      continue;
    }
    if (rule.receipt && !hasReceipt) {
      unattributable.push({
        detail: `tx ${feedback.transactionHash}: paid review carries no receipt id`,
      });
      continue;
    }

    // Every candidate needs an explicit revocation status. Without one there
    // is no way to tell a live entry from a revoked one.
    const revoked = revokedByIndex.get(`${gatewayKey}:${feedbackIndex.toString()}`);
    if (revoked === undefined) {
      unattributable.push({
        detail: `feedback index ${feedbackIndex} has no revocation status at block ${snapshotBlock}`,
      });
      continue;
    }

    let paymentAmount: bigint | undefined;
    if (reviewType === REVIEW_TYPE_PAID && receiptId !== undefined) {
      const receipt = reusedReceipts.has(receiptId) ? undefined : receiptById.get(receiptId);
      if (receipt === undefined) {
        // Left undefined so the engine excludes it as `missing_payment`
        // rather than this layer inventing a weight.
        paymentAmount = undefined;
      } else if (
        receipt.agentId !== agentId ||
        getAddress(receipt.payer) !== getAddress(reviewer) ||
        !receipt.spent ||
        receipt.amount < 0n
      ) {
        unattributable.push({
          detail: `receipt ${receiptId} does not match the review it backs`,
        });
        paymentAmount = undefined;
      } else {
        paymentAmount = receipt.amount;
      }
    }

    reviews.push({
      nullifier: normalizeNullifier(nullifier),
      reviewer,
      gateway: gatewayKey,
      value,
      valueDecimals,
      reviewType,
      paymentAmount,
      revoked,
      feedbackIndex,
      blockNumber: feedback.blockNumber,
      logIndex: feedback.logIndex,
    });
  }

  return { reviews, snapshotBlock, unattributable };
}

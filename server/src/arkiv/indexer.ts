import { getAddress } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { newFeedbackAbi, reviewSubmittedAbi } from '../reputation/retrieval.js';
import type { GatewaySource } from '../reputation/retrieval.js';
import type { ConfirmedReview } from './records.js';

/**
 * Find every Receipts review that is confirmed on Sepolia.
 *
 * A review is the pair of events the gateway emits in one transaction:
 * `ReviewSubmitted` (reviewer, type, receipt) and the registry's
 * `NewFeedback` (value, tags, feedback index). Pairing follows the same rules
 * as `retrieveReviews`: exactly one of each per transaction, both from the
 * same gateway, agreeing on agent and feedbackHash. Anything else is reported
 * and skipped, never guessed at.
 *
 * Unlike `retrieveReviews` this is not scoped to one agent, and it stops
 * `confirmations` blocks behind the head: a review is only published to
 * Arkiv once it is unlikely to be reorged out, because a readonly entity for
 * a transaction that no longer exists could not be corrected.
 */
export interface IndexerConfig {
  readonly client: PublicClient;
  readonly reputationRegistry: Address;
  /** Every gateway whose reviews are published, each from its deploy block. */
  readonly gateways: readonly GatewaySource[];
  readonly confirmations: bigint;
  readonly maxLogRange?: bigint;
}

export interface IndexResult {
  readonly reviews: readonly ConfirmedReview[];
  /** The last block scanned. */
  readonly toBlock: bigint;
  readonly skipped: readonly { readonly detail: string }[];
}

const DEFAULT_MAX_LOG_RANGE = 50_000n;

export async function indexConfirmedReviews(config: IndexerConfig): Promise<IndexResult> {
  const { client } = config;
  const head = await client.getBlockNumber();
  const toBlock = head > config.confirmations ? head - config.confirmations : 0n;
  const maxRange = config.maxLogRange ?? DEFAULT_MAX_LOG_RANGE;
  const skipped: { detail: string }[] = [];
  const reviews: ConfirmedReview[] = [];

  for (const gateway of dedupeGateways(config.gateways)) {
    const feedback = [];
    const submitted = [];
    for (let from = gateway.fromBlock; from <= toBlock; from += maxRange) {
      const to = from + maxRange - 1n > toBlock ? toBlock : from + maxRange - 1n;
      feedback.push(
        ...(await client.getContractEvents({
          address: config.reputationRegistry,
          abi: newFeedbackAbi,
          eventName: 'NewFeedback',
          args: { clientAddress: gateway.address },
          fromBlock: from,
          toBlock: to,
        })),
      );
      submitted.push(
        ...(await client.getContractEvents({
          address: gateway.address,
          abi: reviewSubmittedAbi,
          eventName: 'ReviewSubmitted',
          fromBlock: from,
          toBlock: to,
        })),
      );
    }

    const feedbackByTx = groupByTx(feedback);
    const submittedByTx = groupByTx(submitted);

    for (const [tx, logs] of submittedByTx) {
      const pair = feedbackByTx.get(tx);
      const review = logs[0];
      const entry = pair?.[0];
      if (logs.length !== 1 || pair === undefined || pair.length !== 1) {
        skipped.push({
          detail: `tx ${tx}: ${logs.length} ReviewSubmitted / ${pair?.length ?? 0} NewFeedback, expected 1 / 1`,
        });
        continue;
      }
      if (review === undefined || entry === undefined) continue;

      // The nullifier is decoded with the rest of the event and dropped here.
      const { agentId, reviewer, reviewType, receiptId, feedbackHash } = review.args;
      const {
        agentId: feedbackAgent,
        feedbackIndex,
        value,
        valueDecimals,
        tag2,
        feedbackHash: entryHash,
      } = entry.args;

      if (
        agentId === undefined ||
        reviewer === undefined ||
        reviewType === undefined ||
        receiptId === undefined ||
        feedbackHash === undefined ||
        feedbackAgent === undefined ||
        feedbackIndex === undefined ||
        value === undefined ||
        valueDecimals === undefined ||
        tag2 === undefined ||
        entryHash === undefined ||
        review.logIndex === null ||
        review.blockNumber === null
      ) {
        skipped.push({ detail: `tx ${tx}: incomplete log pair` });
        continue;
      }
      if (agentId !== feedbackAgent || feedbackHash !== entryHash) {
        skipped.push({ detail: `tx ${tx}: ReviewSubmitted and NewFeedback disagree` });
        continue;
      }

      reviews.push({
        agentId,
        gateway: getAddress(gateway.address),
        reviewer: getAddress(reviewer),
        reviewType,
        tag: tag2,
        value,
        valueDecimals,
        feedbackIndex,
        feedbackHash,
        receiptId,
        txHash: tx as Hex,
        logIndex: review.logIndex,
        blockNumber: review.blockNumber,
      });
    }

    for (const tx of feedbackByTx.keys()) {
      if (!submittedByTx.has(tx))
        skipped.push({ detail: `tx ${tx}: NewFeedback with no ReviewSubmitted` });
    }
  }

  reviews.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );
  return { reviews, toBlock, skipped };
}

function dedupeGateways(gateways: readonly GatewaySource[]): GatewaySource[] {
  const byKey = new Map<string, GatewaySource>();
  for (const g of gateways) {
    const key = g.address.toLowerCase();
    const existing = byKey.get(key);
    if (existing === undefined || g.fromBlock < existing.fromBlock) byKey.set(key, g);
  }
  return [...byKey.values()];
}

function groupByTx<T extends { transactionHash: string | null }>(
  logs: readonly T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const log of logs) {
    if (log.transactionHash === null) continue;
    const key = log.transactionHash.toLowerCase();
    const list = out.get(key);
    if (list === undefined) out.set(key, [log]);
    else list.push(log);
  }
  return out;
}

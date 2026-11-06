import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import type { Hex } from 'viem';
import { loadEnv } from '../src/config/env.js';
import {
  REVIEW_TYPE,
  WALLET_NULLIFIER_DOMAIN,
  ZERO_BYTES32,
  reviewContentIssues,
  walletNullifier,
} from '../src/signing/reviewContent.js';
import { VALID_ENV } from './fixtures.js';

/**
 * Cross-implementation vectors.
 *
 * The same constants are asserted in test/WalletReview.t.sol against the
 * deployed-contract implementation (`ReviewGateway.walletNullifier`). They were
 * produced by the TypeScript implementation and confirmed by `forge test`; if
 * either side changes its domain or encoding, one suite fails.
 */
const VECTORS = [
  {
    reviewer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    nullifier: '0x6cce3018996d769b7669cde1d1a272a46b64b415112f7036d7d25ab1fcceb42a',
  },
  {
    reviewer: '0x000000000000000000000000000000000000dEaD',
    nullifier: '0xfe2c650674fc7638504f0b37ee871ae186f5d5ea614ac624fa5036ed06ec5369',
  },
] as const;

describe('walletNullifier', () => {
  it('uses the contract domain keccak256("ReceiptsWalletReview(v1)")', () => {
    expect(WALLET_NULLIFIER_DOMAIN).toBe(
      '0x16ed5e06521b78419d8381227e4eaf6dd97c5c2c119dd43188c5dbdda7f6e81e',
    );
  });

  it.each(VECTORS)('matches the Solidity vector for $reviewer', ({ reviewer, nullifier }) => {
    expect(walletNullifier(reviewer)).toBe(nullifier);
  });

  it('does not depend on address casing', () => {
    const [{ reviewer, nullifier }] = VECTORS;
    expect(walletNullifier(reviewer.toLowerCase() as Hex)).toBe(nullifier);
  });
});

describe('wallet review content rules', () => {
  const reviewer = getAddress(VECTORS[0].reviewer);
  const base = {
    agentId: 7n,
    nullifier: walletNullifier(reviewer),
    reviewer,
    value: 80n,
    valueDecimals: 0,
    feedbackHash: `0x${'44'.repeat(32)}` as Hex,
    reviewType: REVIEW_TYPE.WALLET as number,
    receiptId: ZERO_BYTES32,
  };

  it('accepts a wallet review with its own nullifier and a zero receipt', () => {
    expect(reviewContentIssues(base)).toEqual([]);
  });

  it('rejects a World ID style nullifier', () => {
    const issues = reviewContentIssues({ ...base, nullifier: `0x${'00'.repeat(31)}07` });
    expect(issues.map((i) => i.field)).toEqual(['nullifier']);
  });

  it("rejects another wallet's nullifier", () => {
    const issues = reviewContentIssues({ ...base, nullifier: VECTORS[1].nullifier });
    expect(issues.map((i) => i.field)).toEqual(['nullifier']);
  });

  it('rejects a receipt on a wallet review', () => {
    const issues = reviewContentIssues({ ...base, receiptId: `0x${'77'.repeat(32)}` });
    expect(issues.map((i) => i.field)).toEqual(['receiptId']);
  });

  it('keeps 3 and above invalid', () => {
    expect(reviewContentIssues({ ...base, reviewType: 3 }).map((i) => i.field)).toContain(
      'reviewType',
    );
  });
});

describe('WALLET_REVIEWS_ENABLED', () => {
  it('defaults to false', () => {
    expect(loadEnv({ ...VALID_ENV }).walletReviewsEnabled).toBe(false);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('parses %s', (raw, expected) => {
    expect(loadEnv({ ...VALID_ENV, WALLET_REVIEWS_ENABLED: raw }).walletReviewsEnabled).toBe(
      expected,
    );
  });

  it.each(['1', 'yes', 'TRUE', 'enabled'])('rejects %s rather than reading it as false', (raw) => {
    expect(() => loadEnv({ ...VALID_ENV, WALLET_REVIEWS_ENABLED: raw })).toThrow(
      /WALLET_REVIEWS_ENABLED/,
    );
  });
});

describe('ADDITIONAL_REVIEW_GATEWAYS', () => {
  const OLD = '0x1111111111111111111111111111111111111111';
  const OLDER = '0x2222222222222222222222222222222222222222';

  it('defaults to none', () => {
    expect(loadEnv({ ...VALID_ENV }).additionalGateways).toEqual([]);
  });

  it('parses address@block entries', () => {
    const env = loadEnv({ ...VALID_ENV, ADDITIONAL_REVIEW_GATEWAYS: `${OLD}@100, ${OLDER}@7` });
    expect(env.additionalGateways).toEqual([
      { address: getAddress(OLD), fromBlock: 100n },
      { address: getAddress(OLDER), fromBlock: 7n },
    ]);
  });

  it.each([
    OLD, // block required
    `${OLD}@`,
    `${OLD}@-1`,
    `${OLD}@1@2`,
    `0x123@5`,
    `0x${'00'.repeat(20)}@5`,
    `${OLD}@5,garbage`,
  ])('rejects %s', (raw) => {
    expect(() => loadEnv({ ...VALID_ENV, ADDITIONAL_REVIEW_GATEWAYS: raw })).toThrow(
      /ADDITIONAL_REVIEW_GATEWAYS/,
    );
  });
});

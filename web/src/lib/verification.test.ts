import { describe, expect, it } from 'vitest';
import { REVIEW_TAG2, VERIFICATION_LABEL, WALLET_TOOLTIP, verificationOf } from './reviews';

describe('verificationOf', () => {
  it('maps the three known type and tag pairs', () => {
    expect(verificationOf(0, REVIEW_TAG2.human)).toBe('world_id_human');
    expect(verificationOf(1, REVIEW_TAG2.paid)).toBe('world_id_human_paid');
    expect(verificationOf(2, REVIEW_TAG2.wallet)).toBe('wallet_only');
  });

  it('derives from the type alone when no tag is supplied', () => {
    expect(verificationOf(0)).toBe('world_id_human');
    expect(verificationOf(1, null)).toBe('world_id_human_paid');
    expect(verificationOf(2, undefined)).toBe('wallet_only');
  });

  it('fails closed on every mismatched or unknown combination', () => {
    const types = [0, 1, 2, 3, 7, 255, -1];
    const tags = [REVIEW_TAG2.human, REVIEW_TAG2.paid, REVIEW_TAG2.wallet, '', 'verified', 'x'];
    const valid = new Set(['0:human-verified', '1:receipt-verified', '2:wallet-verified']);

    for (const type of types) {
      for (const tag of tags) {
        const result = verificationOf(type, tag);
        if (valid.has(`${type}:${tag}`)) {
          expect(result).not.toBe('unverified');
        } else {
          expect(result, `${type}/${tag}`).toBe('unverified');
        }
      }
    }
    expect(verificationOf(3)).toBe('unverified');
    expect(verificationOf(Number.NaN)).toBe('unverified');
  });

  it('never upgrades a wallet review to a human or receipt claim', () => {
    for (const tag of [undefined, null, 'human-verified', 'receipt-verified', 'wallet-verified']) {
      const result = verificationOf(2, tag);
      expect(result).not.toBe('world_id_human');
      expect(result).not.toBe('world_id_human_paid');
    }
  });

  it('uses the specified labels and tooltip wording', () => {
    expect(VERIFICATION_LABEL).toEqual({
      world_id_human: 'Human-verified',
      world_id_human_paid: 'Human-verified · Paid',
      wallet_only: 'Wallet-verified',
      unverified: 'Unverified',
    });
    expect(WALLET_TOOLTIP).toBe(
      'A wallet signed this review. This does not prove one person, since one person can control many wallets. Not counted in the reputation score.',
    );
  });
});

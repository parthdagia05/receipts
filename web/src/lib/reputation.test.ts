import { describe, expect, it } from 'vitest';
import { readTiers, verifiedHumanCount } from './reputation';

const tier = (over: Record<string, unknown> = {}) => ({
  score: 80,
  count: 6,
  threshold: 5,
  status: 'published',
  totalWeight: '6',
  ...over,
});

describe('readTiers', () => {
  it('reads all three tiers', () => {
    const tiers = readTiers({
      tiers: {
        human: tier(),
        receipt: tier({ count: 2 }),
        wallet: tier({ score: null, count: 9, totalWeight: '0', status: 'informational' }),
      },
    });
    expect(tiers?.human.count).toBe(6);
    expect(tiers?.receipt.count).toBe(2);
    expect(tiers?.wallet.count).toBe(9);
    expect(tiers?.wallet.status).toBe('informational');
  });

  it('never exposes a wallet score, even if the server sends one', () => {
    const tiers = readTiers({
      tiers: { human: tier(), receipt: tier(), wallet: tier({ score: 99 }) },
    });
    expect(tiers?.wallet.score).toBeNull();
  });

  it('returns null for absent, partial or malformed blocks', () => {
    expect(readTiers({})).toBeNull();
    expect(readTiers({ tiers: 'x' })).toBeNull();
    expect(readTiers({ tiers: { human: tier(), receipt: tier() } })).toBeNull();
    expect(
      readTiers({ tiers: { human: tier(), receipt: tier(), wallet: tier({ count: -1 }) } }),
    ).toBeNull();
  });

  it('marks an unrecognised status as unknown instead of trusting it', () => {
    const tiers = readTiers({
      tiers: { human: tier({ status: 'weird' }), receipt: tier(), wallet: tier() },
    });
    expect(tiers?.human.status).toBe('unknown');
  });
});

describe('verifiedHumanCount', () => {
  it('uses the top-level distinct_humans and ignores wallet reviews', () => {
    const response = {
      distinct_humans: 4,
      tiers: { human: tier({ count: 4 }), receipt: tier(), wallet: tier({ count: 50 }) },
    };
    expect(verifiedHumanCount(response)).toBe(4);
    expect(readTiers(response)?.wallet.count).toBe(50);
  });
});

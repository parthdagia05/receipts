import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { ReputationResponse } from '../lib/api';
import { WALLET_TOOLTIP } from '../lib/reviews';
import type { ReviewRecord } from '../lib/reviews';
import { StepSelectAgent } from '../pages/SubmitReview';
import { ReputationTiers } from './ReputationTiers';
import { ReviewRow } from './ReviewList';
import { VerificationBadge } from './VerificationBadge';

const html = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

const review = (reviewType: number): ReviewRecord => ({
  agentId: 7n,
  reviewer: '0x00000000000000000000000000000000000000aa',
  nullifier: '0x01' as Hex,
  reviewType,
  receiptId: '0x00' as Hex,
  feedbackHash: '0x02' as Hex,
  blockNumber: 1n,
  transactionHash: '0x03' as Hex,
});

describe('VerificationBadge', () => {
  it('renders the specified label for each type', () => {
    expect(html(<VerificationBadge verification="world_id_human" />)).toContain('Human-verified');
    expect(html(<VerificationBadge verification="world_id_human_paid" />)).toContain(
      'Human-verified · Paid',
    );
    expect(html(<VerificationBadge verification="unverified" />)).toContain('Unverified');
  });

  it('shows the wallet tooltip and never claims human or receipt verification', () => {
    const out = html(<VerificationBadge verification="wallet_only" />);
    expect(out).toContain('Wallet-verified');
    expect(out).toContain(WALLET_TOOLTIP.replace(/'/g, '&#x27;'));
    expect(out).not.toContain('Human-verified');
    expect(out).not.toContain('Receipt-verified');
  });
});

describe('ReviewRow', () => {
  it('labels free, paid and wallet reviews correctly', () => {
    expect(html(<ReviewRow review={review(0)} />)).toContain('Human-verified');
    expect(html(<ReviewRow review={review(1)} />)).toContain('Human-verified · Paid');
    const wallet = html(<ReviewRow review={review(2)} />);
    expect(wallet).toContain('Wallet-verified');
    expect(wallet).not.toContain('Human-verified');
    expect(wallet).not.toContain('Receipt-verified');
  });

  it('fails closed for an unknown review type', () => {
    const out = html(<ReviewRow review={review(9)} />);
    expect(out).toContain('Unverified');
    expect(out).not.toContain('Receipt-verified');
    expect(out).not.toContain('Human-verified');
  });
});

describe('ReputationTiers', () => {
  const base = {
    distinct_humans: 4,
    tiers: {
      human: { score: 80, count: 4, threshold: 5, status: 'below_threshold', totalWeight: '4' },
      receipt: { score: null, count: 1, threshold: 5, status: 'below_threshold', totalWeight: '2' },
      wallet: { score: 99, count: 12, status: 'informational', totalWeight: '0' },
    },
  } as unknown as ReputationResponse;

  it('shows three categories, an overlap warning and no wallet score', () => {
    const out = html(<ReputationTiers reputation={base} />);
    expect(out).toContain('Human-verified');
    expect(out).toContain('Paid');
    expect(out).toContain('Wallet-verified');
    expect(out).toContain('overlap');
    expect(out).toContain('never counted in the score');
    // Score rows exist for human and receipt only.
    expect(out.match(/>Score</g)?.length).toBe(2);
    expect(out).not.toContain('>99<');
  });

  it('renders nothing when the server sent no tiers', () => {
    expect(
      html(<ReputationTiers reputation={{ distinct_humans: 1 } as ReputationResponse} />),
    ).toBe('');
  });
});

describe('wizard method choice (feature flag)', () => {
  const wallet = {
    address: null,
    available: true,
    connecting: false,
    isCorrectChain: true,
    connect: async () => undefined,
    switchChain: async () => undefined,
  } as unknown as Parameters<typeof StepSelectAgent>[0]['wallet'];

  const render = (methods: readonly ('world_id' | 'wallet')[]) =>
    html(
      <StepSelectAgent
        agentId={7n}
        loading={false}
        owner={null}
        found
        blocked={null}
        wallet={wallet}
        method="world_id"
        methods={methods}
        onMethod={() => undefined}
      />,
    );

  it('hides every wallet-only control when the flag is off', () => {
    const out = render(['world_id']);
    expect(out).not.toContain('Wallet only');
    expect(out).not.toContain('radiogroup');
  });

  it('offers wallet-only next to World ID when the flag is on', () => {
    const out = render(['world_id', 'wallet']);
    expect(out).toContain('Wallet only');
    expect(out).toContain('World ID');
  });
});

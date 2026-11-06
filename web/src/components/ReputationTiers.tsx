import { readTiers } from '../lib/reputation';
import type { ReputationTier } from '../lib/reputation';
import type { ReputationResponse } from '../lib/api';
import { WALLET_TOOLTIP } from '../lib/reviews';
import { Badge, Card, CardHeader, DescriptionList, DescriptionRow, Notice } from './ui';
import type { Tone } from './ui';

function statusBadge(tier: ReputationTier) {
  const map: Record<string, { tone: Tone; text: string }> = {
    published: { tone: 'success', text: 'Published' },
    below_threshold: { tone: 'warning', text: 'Below threshold' },
    no_eligible_reviews: { tone: 'neutral', text: 'No eligible reviews' },
    informational: { tone: 'neutral', text: 'Informational' },
  };
  const entry = map[tier.status] ?? { tone: 'neutral' as Tone, text: 'Unavailable' };
  return (
    <Badge tone={entry.tone} dot>
      {entry.text}
    </Badge>
  );
}

function TierCard({
  title,
  description,
  tier,
  scored,
}: {
  title: string;
  description: string;
  tier: ReputationTier;
  /** False for the wallet tier: it never shows a score. */
  scored: boolean;
}) {
  return (
    <Card nested>
      <CardHeader title={title} description={description} action={statusBadge(tier)} />
      <DescriptionList>
        {scored && (
          <DescriptionRow term="Score">{tier.score === null ? '—' : tier.score}</DescriptionRow>
        )}
        <DescriptionRow term="Reviews">{tier.count}</DescriptionRow>
        {scored && tier.threshold !== null && (
          <DescriptionRow term="Threshold">{tier.threshold} to publish</DescriptionRow>
        )}
      </DescriptionList>
    </Card>
  );
}

/**
 * The three reputation categories, side by side and never merged.
 *
 * Human and receipt overlap, because a paid review is human-verified too, so
 * the counts are not added anywhere. The wallet panel is informational only:
 * no score, and no part of the "N verified humans" figure.
 */
export function ReputationTiers({ reputation }: { reputation: ReputationResponse }) {
  const tiers = readTiers(reputation);
  if (tiers === null) return null;

  return (
    <Card>
      <CardHeader
        title="Reputation by verification"
        description="Separate categories, not a single blended score"
      />
      <div style={{ display: 'grid', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
        <TierCard
          title="Human-verified"
          description="Unique people verified with World ID"
          tier={tiers.human}
          scored
        />
        <TierCard
          title="Paid"
          description="Human-verified reviews that also carry a settled USDC receipt"
          tier={tiers.receipt}
          scored
        />
        <TierCard
          title="Wallet-verified"
          description={WALLET_TOOLTIP}
          tier={tiers.wallet}
          scored={false}
        />
        <Notice tone="info">
          Human-verified and Paid overlap: a paid review counts in both, so do not add them
          together. Wallet-verified reviews are shown for transparency and are never counted in the
          score or in the number of verified humans.
        </Notice>
      </div>
    </Card>
  );
}

import { VERIFICATION_LABEL, VERIFICATION_TOOLTIP } from '../lib/reviews';
import type { VerificationType } from '../lib/reviews';
import { Badge } from './ui';
import type { Tone } from './ui';

const TONE: Readonly<Record<VerificationType, Tone>> = {
  world_id_human: 'success',
  world_id_human_paid: 'success',
  wallet_only: 'warning',
  unverified: 'neutral',
};

/**
 * What a review's verification proves, in words that cannot be misread.
 *
 * Wallet-verified uses a different tone and its own label so it is never
 * mistaken for a human claim; the tooltip says what it does and does not
 * establish. The text is also exposed as the accessible name, so it reaches
 * keyboard and screen-reader users, not just those who can hover.
 */
export function VerificationBadge({ verification }: { verification: VerificationType }) {
  const label = VERIFICATION_LABEL[verification];
  const tooltip = VERIFICATION_TOOLTIP[verification];

  return (
    <span
      title={tooltip}
      tabIndex={0}
      aria-label={`${label}. ${tooltip}`}
      style={{ cursor: 'help' }}
      data-verification={verification}
    >
      <Badge tone={TONE[verification]} dot>
        {label}
      </Badge>
    </span>
  );
}

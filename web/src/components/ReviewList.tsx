import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchReviewContent } from '../lib/api';
import { txUrl } from '../lib/config';
import { absoluteTime, relativeTime, shortAddress, shortHash } from '../lib/format';
import { verificationOf } from '../lib/reviews';
import type { ReviewRecord } from '../lib/reviews';
import { Copyable, ExternalLink } from './ui';
import { VerificationBadge } from './VerificationBadge';
import styles from '../pages/pages.module.css';

/**
 * Review text, fetched from the Record Server by its content hash.
 *
 * On-chain a review carries only `feedbackHash` and the signed `feedbackURI`;
 * the words live off-chain. A server that does not hold this particular hash —
 * because the review was written against a different deployment, or because
 * the content base URL has changed — simply has no text to give, and that is
 * stated plainly rather than papered over.
 */
function ReviewText({ feedbackHash }: { feedbackHash: string }) {
  const [state, setState] = useState<{ status: 'loading' | 'done'; text: string | null }>({
    status: 'loading',
    text: null,
  });

  useEffect(() => {
    let cancelled = false;
    void fetchReviewContent(feedbackHash).then((text) => {
      if (!cancelled) setState({ status: 'done', text });
    });
    return () => {
      cancelled = true;
    };
  }, [feedbackHash]);

  if (state.status === 'loading') {
    return (
      <div
        className={styles.reviewText}
        style={{ height: 16, width: '70%', background: 'var(--surface-raised)', borderRadius: 4 }}
      />
    );
  }

  if (state.text === null) {
    return (
      <p className={[styles.reviewText, styles.reviewTextMissing].join(' ')}>
        Content not held by this Record Server.
      </p>
    );
  }

  return <p className={styles.reviewText}>{state.text}</p>;
}

/**
 * One review.
 *
 * The rating is deliberately absent from `ReviewSubmitted` — the event carries
 * the evidence hash, not the score, because the score is authoritative in
 * ERC-8004. Rather than guess, the chip shows the hash prefix and the rating is
 * read from the registry on the agent page where the full feedback is loaded.
 */
export function ReviewRow({
  review,
  showAgent = true,
  rating,
}: {
  review: ReviewRecord;
  showAgent?: boolean;
  rating?: number;
}) {
  const relative = relativeTime(review.timestamp);
  const absolute = absoluteTime(review.timestamp);

  return (
    <article className={styles.reviewItem}>
      {rating === undefined ? (
        <div
          className={styles.scoreChip}
          style={{ fontSize: 'var(--text-xs)' }}
          title="Rating lives in the ERC-8004 registry; open the agent to see it."
        >
          ✓
        </div>
      ) : (
        <div className={styles.scoreChip}>{rating}</div>
      )}

      <div className={styles.reviewBody}>
        <div className={styles.reviewTop}>
          {showAgent && (
            <Link to={`/agents/${review.agentId.toString(10)}`}>
              <strong style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                Agent #{review.agentId.toString(10)}
              </strong>
            </Link>
          )}
          <VerificationBadge verification={verificationOf(review.reviewType)} />
          {relative !== null && (
            <span
              style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}
              title={absolute ?? undefined}
            >
              {relative}
            </span>
          )}
        </div>

        <ReviewText feedbackHash={review.feedbackHash} />

        <div className={styles.reviewFoot}>
          <span>
            by <Copyable value={review.reviewer} display={shortAddress(review.reviewer)} />
          </span>
          <ExternalLink href={txUrl(review.transactionHash)}>
            {shortHash(review.transactionHash)}
          </ExternalLink>
        </div>
      </div>
    </article>
  );
}

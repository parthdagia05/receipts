import { Link } from 'react-router-dom';
import { ReviewRow } from '../components/ReviewList';
import { Button, Card, EmptyState, Skeleton } from '../components/ui';
import { RefreshIcon, ReviewsIcon } from '../components/ui/Icons';
import { useAsync } from '../hooks/useAsync';
import { attachTimestamps, loadReviews } from '../lib/reviews';
import styles from './pages.module.css';

/**
 * Every review this gateway has written, newest first.
 *
 * Sourced from `ReviewSubmitted` rather than from the Reputation Registry: the
 * registry records the gateway as the feedback author, so it cannot tell you
 * which human wrote which review. The gateway's own event can.
 */
export function Reviews() {
  const reviews = useAsync(async () => attachTimestamps(await loadReviews({ limit: 50 })), []);

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>
            Reviews <span className={styles.pageTitleMuted}>· Activity</span>
          </h1>
          <p className={styles.pageSubtitle}>
            Every review written by the Receipts gateway, read from on-chain events.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshIcon size={14} />}
          onClick={reviews.reload}
          loading={reviews.loading}
        >
          Refresh
        </Button>
      </div>

      <Card>
        {reviews.loading ? (
          <div style={{ padding: 'var(--space-5)', display: 'grid', gap: 'var(--space-4)' }}>
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} height={56} />
            ))}
          </div>
        ) : reviews.error !== null ? (
          <EmptyState
            title="Couldn't load reviews"
            body="The RPC endpoint didn't respond while scanning for events."
            action={
              <Button variant="secondary" size="sm" onClick={reviews.reload}>
                Try again
              </Button>
            }
          />
        ) : reviews.data === null || reviews.data.length === 0 ? (
          <EmptyState
            icon={<ReviewsIcon size={20} />}
            title="No reviews yet"
            body="No reviews have been written to the Reputation Registry yet."
            action={
              <Link to="/agents">
                <Button variant="primary" size="sm">
                  Review an agent
                </Button>
              </Link>
            }
          />
        ) : (
          <div>
            {reviews.data.map((review) => (
              <ReviewRow key={review.transactionHash} review={review} />
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

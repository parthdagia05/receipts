import { useId } from 'react';
import {
  MARK_GROUND,
  MARK_RADIUS,
  MARK_SHARDS,
  MARK_SIZE,
  MARK_STROKE,
  MARK_STROKE_WIDTH,
} from '../brand/mark';

/**
 * The Receipts mark.
 *
 * Drawn from the shard definition in `brand/mark.ts`, which also generates the
 * favicon, so the two always match. The clip path id is per-instance because
 * several marks can share a page and a duplicated id would make one of them
 * clip against the wrong rectangle.
 */
export function Logo({ size = 30 }: { size?: number }) {
  const clipId = useId();

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${MARK_SIZE} ${MARK_SIZE}`}
      role="img"
      aria-label="Receipts"
    >
      <clipPath id={clipId}>
        <rect width={MARK_SIZE} height={MARK_SIZE} rx={MARK_RADIUS} />
      </clipPath>
      <g
        clipPath={`url(#${clipId})`}
        stroke={MARK_STROKE}
        strokeWidth={MARK_STROKE_WIDTH}
        strokeLinejoin="round"
      >
        <rect width={MARK_SIZE} height={MARK_SIZE} fill={MARK_GROUND} stroke="none" />
        {MARK_SHARDS.map((shard) => (
          <polygon key={shard.points} points={shard.points} fill={shard.fill} />
        ))}
      </g>
    </svg>
  );
}

export function Wordmark({ size = 30 }: { size?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <Logo size={size} />
      <span
        style={{
          fontSize: 'var(--text-md)',
          fontWeight: 700,
          letterSpacing: '-0.02em',
          color: 'var(--text-primary)',
        }}
      >
        Receipts
      </span>
    </span>
  );
}

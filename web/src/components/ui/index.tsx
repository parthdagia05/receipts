import { useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  ExternalIcon,
  InboxIcon,
  InfoIcon,
  SpinnerIcon,
} from './Icons';
import styles from './ui.module.css';

/* --- Card ---------------------------------------------------------------- */

export function Card({
  children,
  padded = false,
  nested = false,
  className,
}: {
  children: ReactNode;
  padded?: boolean;
  /** Set when this card sits inside another one. */
  nested?: boolean;
  /* CSS-module lookups are `string | undefined` under this tsconfig, so the
     prop has to admit undefined rather than make every caller assert. */
  className?: string | undefined;
}) {
  return (
    <div
      className={[
        styles.card,
        padded ? styles.cardPad : '',
        nested ? styles.cardNested : '',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
  bare = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  bare?: boolean;
}) {
  return (
    <div className={[styles.cardHeader, bare ? styles.cardHeaderBare : ''].join(' ')}>
      <div>
        <div className={styles.cardTitle}>{title}</div>
        {description !== undefined && <div className={styles.cardDescription}>{description}</div>}
      </div>
      {action}
    </div>
  );
}

export function SectionHeading({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={styles.cardHeader} style={{ padding: 0, border: 'none' }}>
      <div>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {subtitle !== undefined && <p className={styles.sectionSubtitle}>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/* --- Button -------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: styles.variantPrimary ?? '',
  secondary: styles.variantSecondary ?? '',
  ghost: styles.variantGhost ?? '',
  danger: styles.variantDanger ?? '',
};

const SIZE_CLASS: Record<'sm' | 'md' | 'lg', string> = {
  sm: styles.sizeSm ?? '',
  md: styles.sizeMd ?? '',
  lg: styles.sizeLg ?? '',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly loading?: boolean;
  readonly fullWidth?: boolean;
  readonly icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  fullWidth = false,
  icon,
  children,
  disabled,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={[
        styles.button,
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        fullWidth ? styles.buttonFull : '',
        className ?? '',
      ].join(' ')}
      disabled={disabled === true || loading}
      {...props}
    >
      {loading ? <SpinnerIcon size={14} /> : icon}
      {children}
    </button>
  );
}

/* --- Badge --------------------------------------------------------------- */

/** A badge's tone no longer changes its surface, only its status dot. */
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const DOT_CLASS: Record<Tone, string> = {
  neutral: '',
  accent: styles.dotAccent ?? '',
  success: styles.dotSuccess ?? '',
  warning: styles.dotWarning ?? '',
  danger: styles.dotDanger ?? '',
};

export function Badge({
  tone = 'neutral',
  dot = false,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={styles.badge}>
      {dot && <span className={[styles.dot, DOT_CLASS[tone]].join(' ')} />}
      {children}
    </span>
  );
}

/* --- Stat ---------------------------------------------------------------- */

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className={styles.statGrid}>{children}</div>;
}

/**
 * A single metric.
 *
 * `value` of `null` renders an em dash rather than a zero: "we could not read
 * this" and "this is zero" are different facts, and showing 0 for an RPC
 * failure would be fabricating data. `status` is for a badge the card can
 * actually substantiate, never a decorative one.
 */
export function Stat({
  label,
  value,
  hint,
  icon,
  status,
  loading = false,
}: {
  label: string;
  value: string | null;
  hint?: ReactNode;
  icon?: ReactNode;
  status?: ReactNode;
  loading?: boolean;
}) {
  return (
    <Card>
      <div className={styles.stat}>
        {icon !== undefined && <div className={styles.statIcon}>{icon}</div>}
        <div className={styles.statBody}>
          {loading ? (
            <div className={styles.skeleton} style={{ height: 26, width: '55%' }} />
          ) : (
            <div
              className={[styles.statValue, value === null ? styles.statValueMuted : ''].join(' ')}
            >
              {value ?? '—'}
            </div>
          )}
          <div className={styles.statLabel}>{label}</div>
          {status !== undefined && <div className={styles.statStatus}>{status}</div>}
          {hint !== undefined && <div className={styles.statHint}>{hint}</div>}
        </div>
      </div>
    </Card>
  );
}

/* --- Table --------------------------------------------------------------- */

export function Table({
  columns,
  children,
  wide = false,
}: {
  columns: readonly string[];
  children: ReactNode;
  /** Hold a minimum width and scroll rather than wrap. For wide tables only. */
  wide?: boolean;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={[styles.table, wide ? styles.tableWide : ''].join(' ')}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/* --- Empty state --------------------------------------------------------- */

export function EmptyState({
  title,
  body,
  icon,
  action,
  compact = false,
}: {
  title: string;
  body: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  /** Tighter padding, for an empty panel sitting beside populated ones. */
  compact?: boolean;
}) {
  return (
    <div className={[styles.empty, compact ? styles.emptyCompact : ''].join(' ')}>
      <div className={styles.emptyIcon}>{icon ?? <InboxIcon size={18} />}</div>
      <div className={styles.emptyTitle}>{title}</div>
      <div className={styles.emptyBody}>{body}</div>
      {action !== undefined && <div className={styles.emptyAction}>{action}</div>}
    </div>
  );
}

/* --- Notice -------------------------------------------------------------- */

const NOTICE_CLASS = {
  info: styles.noticeInfo ?? '',
  warning: styles.noticeWarning ?? '',
  danger: styles.noticeDanger ?? '',
  success: styles.noticeSuccess ?? '',
};

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: keyof typeof NOTICE_CLASS;
  children: ReactNode;
}) {
  const icon =
    tone === 'success' ? (
      <CheckIcon size={16} />
    ) : tone === 'info' ? (
      <InfoIcon size={16} />
    ) : (
      <AlertIcon size={16} />
    );

  return (
    <div className={[styles.notice, NOTICE_CLASS[tone]].join(' ')} role="status">
      <span className={styles.noticeIcon}>{icon}</span>
      <div>{children}</div>
    </div>
  );
}


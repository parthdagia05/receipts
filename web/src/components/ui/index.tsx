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
  tourId,
}: {
  children: ReactNode;
  padded?: boolean;
  /** Set when this card sits inside another one. */
  nested?: boolean;
  /* CSS-module lookups are `string | undefined` under this tsconfig, so the
     prop has to admit undefined rather than make every caller assert. */
  className?: string | undefined;
  /** Marks this card as a product-tour anchor (`data-tour="…"`). */
  tourId?: string | undefined;
}) {
  return (
    <div
      data-tour={tourId}
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

/* --- Fields -------------------------------------------------------------- */

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint !== undefined && <div className={styles.hint}>{hint}</div>}
    </div>
  );
}

export function TextArea({ invalid = false, className, ...props }: TextAreaProps) {
  return (
    <textarea
      className={[styles.textarea, invalid ? styles.inputError : '', className ?? ''].join(' ')}
      {...props}
    />
  );
}

type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { readonly invalid?: boolean };

/* --- Definition list ----------------------------------------------------- */

export function DescriptionList({ children }: { children: ReactNode }) {
  return <dl className={styles.dl}>{children}</dl>;
}

export function DescriptionRow({ term, children }: { term: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.dlRow}>
      <dt className={styles.dt}>{term}</dt>
      <dd className={styles.dd}>{children}</dd>
    </div>
  );
}

/* --- Copyable ------------------------------------------------------------ */

/**
 * A value with a copy affordance.
 *
 * `navigator.clipboard` is unavailable on insecure origins, so a failed copy
 * leaves the label unchanged rather than claiming success.
 */
export function Copyable({ value, display }: { value: string; display?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      /* Clipboard unavailable; the value stays selectable by hand. */
    }
  };

  return (
    <button
      type="button"
      className={styles.copy}
      onClick={() => void copy()}
      title={copied ? 'Copied' : `Copy ${value}`}
    >
      <span className="mono">{display ?? value}</span>
      <span className={styles.copyIcon}>
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      </span>
    </button>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={styles.copy}
      style={{ gap: 'var(--space-1)' }}
    >
      {children}
      <ExternalIcon size={12} className={styles.copyIcon} />
    </a>
  );
}

/* --- Skeleton ------------------------------------------------------------ */

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: string }) {
  return <div className={styles.skeleton} style={{ height, width }} />;
}

/* --- Modal --------------------------------------------------------------- */

/**
 * A focus-trapping dialog.
 *
 * Escape closes it and the scrim is click-through-to-close, which are the two
 * behaviours people try first. Rendered through a portal so a card's
 * `overflow` cannot clip it.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className={styles.scrim}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.modal} role="dialog" aria-modal="true">
        <div className={styles.modalHeader}>
          <div className={styles.cardTitle}>{title}</div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </Button>
        </div>
        <div className={styles.modalBody}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}

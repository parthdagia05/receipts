/** Presentation helpers. No business logic — formatting only. */

/** `0x1234…cDeF`. Keeps enough on both ends to compare two addresses by eye. */
export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 2) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** Same treatment for 32-byte hashes, which need less of the tail to identify. */
export function shortHash(hash: string): string {
  return shortAddress(hash, 10, 6);
}

/** `12,345` — grouped so large agent counts stay readable. */
export function formatCount(value: number | bigint): string {
  return new Intl.NumberFormat('en-US').format(value);
}

/**
 * An ERC-8004 feedback value rendered for display.
 *
 * Values carry their own decimal exponent, so a raw `value` is meaningless
 * without `valueDecimals`. Receipts itself always writes `valueDecimals = 0`
 * with a 0–100 rating, but the registry is shared and other clients may not,
 * so this handles the general case.
 */
export function formatFeedbackValue(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString(10);
  const scaled = Number(value) / 10 ** decimals;
  return scaled.toFixed(Math.min(decimals, 4)).replace(/\.?0+$/, '');
}

/** `2 hours ago`, `just now`. Returns null when there is no timestamp to show. */
export function relativeTime(unixSeconds: number | undefined): string | null {
  if (unixSeconds === undefined) return null;

  const deltaSeconds = Math.floor(Date.now() / 1000) - unixSeconds;
  if (deltaSeconds < 45) return 'just now';

  const units: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  for (const [unit, seconds] of units) {
    if (deltaSeconds >= seconds) {
      return formatter.format(-Math.floor(deltaSeconds / seconds), unit);
    }
  }
  return 'just now';
}

/** `4 Nov 2026, 23:18`. Absolute companion to `relativeTime`. */
export function absoluteTime(unixSeconds: number | undefined): string | null {
  if (unixSeconds === undefined) return null;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(unixSeconds * 1000));
}

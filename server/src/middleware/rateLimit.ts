import { getConnInfo } from '@hono/node-server/conninfo';
import type { MiddlewareHandler } from 'hono';

/**
 * Per-client request limiting.
 *
 * Two routes make this necessary rather than nice to have:
 *
 *   POST /api/reviews/verify              relays to the PAID World ID Portal
 *   GET  /api/agents/:id/reputation       scans logs against an RPC quota
 *
 * Both are unauthenticated. Without a limit, the server is an open relay to
 * someone else's metered API, which is a billing problem before it is a load
 * problem.
 *
 * Fixed-window counters, held in memory. The consequences of that choice,
 * stated plainly because they matter for how this is deployed:
 *
 *   - The limit is PER PROCESS. Two backend instances allow twice the
 *     configured rate. Correct for the single-EC2 deployment this is written
 *     for; it needs Redis or equivalent before horizontal scaling.
 *   - A window boundary allows a burst of up to 2x the limit across two
 *     adjacent windows. A sliding window or token bucket avoids that; a
 *     fixed window is chosen for being obviously correct rather than subtly
 *     wrong, and the limits here are far above legitimate use.
 *   - Counters are lost on restart. That fails open for a moment, which is
 *     the right direction for a limiter that exists to control cost rather
 *     than to enforce authorization.
 */

export interface RateLimitRule {
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Requests permitted per client per window. */
  readonly limit: number;
}

export interface RateLimitConfig {
  /** Applied to every request not matched by a more specific rule. */
  readonly global: RateLimitRule;
  /** Path prefix → rule. The longest matching prefix wins. */
  readonly routes?: Readonly<Record<string, RateLimitRule>>;
  /**
   * Trust `X-Forwarded-For` for the client address.
   *
   * Only enable when the server sits behind a proxy that overwrites the
   * header. Trusting it when directly exposed lets any client claim any
   * address and bypass the limit entirely, so this defaults to false.
   */
  readonly trustProxy?: boolean;
  /** Injectable clock, for tests. */
  readonly now?: () => number;
}

interface Counter {
  count: number;
  resetAt: number;
}

/** Entries are evicted lazily; this bounds the map if a scan cycles addresses. */
const MAX_TRACKED_CLIENTS = 50_000;

/**
 * The client address to count against.
 *
 * Behind a proxy, the LAST entry of `X-Forwarded-For` is the one the proxy
 * itself appended and is the only one it can vouch for. Earlier entries are
 * client-supplied and may be fabricated, so taking the first — the usual
 * mistake — makes the limiter trivially bypassable.
 */
function clientKey(c: Parameters<MiddlewareHandler>[0], trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded !== undefined && forwarded !== '') {
      const hops = forwarded.split(',').map((hop) => hop.trim());
      const last = hops[hops.length - 1];
      if (last !== undefined && last !== '') return last;
    }
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function ruleFor(path: string, config: RateLimitConfig): RateLimitRule {
  let best: RateLimitRule | undefined;
  let bestLength = -1;
  for (const [prefix, rule] of Object.entries(config.routes ?? {})) {
    if (path.startsWith(prefix) && prefix.length > bestLength) {
      best = rule;
      bestLength = prefix.length;
    }
  }
  return best ?? config.global;
}

export function rateLimit(config: RateLimitConfig): MiddlewareHandler {
  const clock = config.now ?? (() => Date.now());
  const counters = new Map<string, Counter>();

  return async (c, next) => {
    const now = clock();
    const rule = ruleFor(new URL(c.req.url).pathname, config);
    const key = `${clientKey(c, config.trustProxy ?? false)}:${rule.windowMs}:${rule.limit}`;

    let counter = counters.get(key);
    if (counter === undefined || counter.resetAt <= now) {
      counter = { count: 0, resetAt: now + rule.windowMs };
      // Evict expired entries only when the map is large, so the common path
      // stays O(1) and a long-running process cannot grow without bound.
      if (counters.size >= MAX_TRACKED_CLIENTS) {
        for (const [existing, value] of counters) {
          if (value.resetAt <= now) counters.delete(existing);
        }
      }
      counters.set(key, counter);
    }

    counter.count += 1;

    const remaining = Math.max(0, rule.limit - counter.count);
    const resetSeconds = Math.ceil((counter.resetAt - now) / 1000);
    c.header('RateLimit-Limit', String(rule.limit));
    c.header('RateLimit-Remaining', String(remaining));
    c.header('RateLimit-Reset', String(resetSeconds));

    if (counter.count > rule.limit) {
      c.header('Retry-After', String(resetSeconds));
      // No detail about the rule or the counter: an attacker tuning against
      // the limiter should not be told how close it is.
      return c.json({ error: 'rate_limited' }, 429);
    }

    await next();
  };
}

/**
 * Defaults sized well above legitimate use.
 *
 * A reviewer completes one journey in four requests. Someone browsing the
 * directory issues a handful of reputation reads. These numbers stop a script,
 * not a person.
 */
export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  global: { windowMs: 60_000, limit: 120 },
  routes: {
    // The expensive ones: a paid third-party API and an RPC log scan.
    '/api/reviews/verify': { windowMs: 60_000, limit: 10 },
    '/api/agents': { windowMs: 60_000, limit: 30 },
    '/api/reputation/simulate': { windowMs: 60_000, limit: 60 },
  },
};

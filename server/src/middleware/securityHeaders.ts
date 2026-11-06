import type { MiddlewareHandler } from 'hono';

/**
 * Response headers applied to everything the server returns.
 *
 * These are cheap and they close real gaps, but note what is already handled
 * elsewhere and deliberately not duplicated here: `routes/reviewContent.ts`
 * sets its own `Content-Type`, `nosniff`, `Content-Disposition` and
 * cache headers, because that route returns reviewer-authored bytes and
 * needed those guarantees before any global middleware existed.
 *
 * `Strict-Transport-Security` is set only when the request arrived over
 * HTTPS. Sending it over plain HTTP is meaningless — a client that can be
 * intercepted can have the header stripped — and in local development it
 * would pin `localhost` to HTTPS in the browser for a year, which is a
 * genuinely annoying thing to do to a teammate.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    // This API returns JSON and plain text. It never returns HTML, never
    // embeds anything, and is never framed, so the restrictive values below
    // cost nothing.
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cross-Origin-Resource-Policy', 'same-site');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    // No camera, microphone or geolocation is used; say so rather than
    // leaving the defaults.
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');

    const proto = c.req.header('x-forwarded-proto');
    const isHttps = proto === 'https' || new URL(c.req.url).protocol === 'https:';
    if (isHttps) {
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  };
}

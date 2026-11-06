import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { rateLimit } from '../src/middleware/rateLimit.js';
import { securityHeaders } from '../src/middleware/securityHeaders.js';
import { loadEnv } from '../src/config/env.js';
import { VALID_ENV } from './fixtures.js';

/**
 * Production middleware: headers, limiting, and the configuration that turns
 * them on. These are the controls that let the API be exposed on a public
 * origin, so each test states the exposure it closes.
 */

function appWith(mw: Parameters<Hono['use']>[1]): Hono {
  const app = new Hono();
  app.use('*', mw);
  app.get('/anything', (c) => c.json({ ok: true }));
  app.get('/api/reviews/verify', (c) => c.json({ ok: true }));
  app.get('/api/agents/1/reputation', (c) => c.json({ ok: true }));
  return app;
}

describe('security headers', () => {
  it('applies the restrictive set to every response', async () => {
    const res = await appWith(securityHeaders()).request('/anything');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-site');
  });

  it('applies them to error responses too, not only successes', async () => {
    const app = new Hono();
    app.use('*', securityHeaders());
    app.get('/boom', () => {
      throw new Error('nope');
    });
    app.onError((_e, c) => c.json({ error: 'internal_error' }, 500));
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('omits HSTS over plain HTTP', async () => {
    // Sending it over HTTP is meaningless, and in development it would pin
    // localhost to HTTPS in the browser for a year.
    const res = await appWith(securityHeaders()).request('http://localhost/anything');
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('sets HSTS when a proxy reports the request arrived over HTTPS', async () => {
    const res = await appWith(securityHeaders()).request('/anything', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
  });
});

describe('rate limiting', () => {
  const config = (over: Record<string, unknown> = {}) => ({
    global: { windowMs: 60_000, limit: 3 },
    now: () => 1_000_000,
    ...over,
  });

  it('allows requests up to the limit and rejects the next', async () => {
    const app = appWith(rateLimit(config()));
    for (let i = 0; i < 3; i++) {
      expect((await app.request('/anything')).status).toBe(200);
    }
    const blocked = await app.request('/anything');
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'rate_limited' });
  });

  it('advertises the limit, remaining count and reset', async () => {
    const res = await appWith(rateLimit(config())).request('/anything');
    expect(res.headers.get('ratelimit-limit')).toBe('3');
    expect(res.headers.get('ratelimit-remaining')).toBe('2');
    expect(Number(res.headers.get('ratelimit-reset'))).toBeGreaterThan(0);
  });

  it('sets Retry-After when it rejects', async () => {
    const app = appWith(rateLimit(config({ global: { windowMs: 60_000, limit: 1 } })));
    await app.request('/anything');
    const blocked = await app.request('/anything');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('starts a fresh window once the old one expires', async () => {
    let now = 1_000_000;
    const app = appWith(
      rateLimit(config({ global: { windowMs: 1_000, limit: 1 }, now: () => now })),
    );
    expect((await app.request('/anything')).status).toBe(200);
    expect((await app.request('/anything')).status).toBe(429);
    now += 1_001;
    expect((await app.request('/anything')).status).toBe(200);
  });

  it('applies the tightest matching prefix, not the global rule', async () => {
    // The expensive route: it relays to a paid third-party API.
    const app = appWith(
      rateLimit(
        config({
          global: { windowMs: 60_000, limit: 100 },
          routes: { '/api/reviews/verify': { windowMs: 60_000, limit: 2 } },
        }),
      ),
    );
    expect((await app.request('/api/reviews/verify')).status).toBe(200);
    expect((await app.request('/api/reviews/verify')).status).toBe(200);
    expect((await app.request('/api/reviews/verify')).status).toBe(429);

    // A different path is unaffected: the counters are per rule.
    expect((await app.request('/anything')).status).toBe(200);
  });

  it('counts a forged X-Forwarded-For against one bucket when proxy trust is off', async () => {
    // Default. Otherwise any caller sets a new header value per request and
    // the limiter is decorative.
    const app = appWith(rateLimit(config({ global: { windowMs: 60_000, limit: 2 } })));
    await app.request('/anything', { headers: { 'x-forwarded-for': '1.1.1.1' } });
    await app.request('/anything', { headers: { 'x-forwarded-for': '2.2.2.2' } });
    const third = await app.request('/anything', { headers: { 'x-forwarded-for': '3.3.3.3' } });
    expect(third.status).toBe(429);
  });

  it('separates clients by the LAST forwarded hop when proxy trust is on', async () => {
    // The last entry is the one the proxy appended; earlier ones are
    // client-supplied and may be fabricated.
    const app = appWith(
      rateLimit(config({ global: { windowMs: 60_000, limit: 1 }, trustProxy: true })),
    );
    const a = await app.request('/anything', { headers: { 'x-forwarded-for': 'fake, 10.0.0.1' } });
    const b = await app.request('/anything', { headers: { 'x-forwarded-for': 'fake, 10.0.0.2' } });
    const again = await app.request('/anything', {
      headers: { 'x-forwarded-for': 'other, 10.0.0.1' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(again.status).toBe(429); // same real hop as `a`
  });
});

describe('CORS configuration', () => {
  it('accepts a list of bare origins', () => {
    const env = loadEnv({
      ...VALID_ENV,
      CORS_ALLOWED_ORIGINS: 'https://receipts.example, https://staging.receipts.example',
    });
    expect(env.corsAllowedOrigins).toEqual([
      'https://receipts.example',
      'https://staging.receipts.example',
    ]);
  });

  it('defaults to no origins, which disables CORS entirely', () => {
    expect(loadEnv(VALID_ENV).corsAllowedOrigins).toEqual([]);
  });

  it('refuses a wildcard', () => {
    // These endpoints spend a World ID verification on an unauthenticated
    // request. Any origin being able to call them is a real exposure.
    expect(() => loadEnv({ ...VALID_ENV, CORS_ALLOWED_ORIGINS: '*' })).toThrow(
      /"\*" is not permitted/,
    );
  });

  it('refuses an entry carrying a path, which could never match an Origin header', () => {
    expect(() =>
      loadEnv({ ...VALID_ENV, CORS_ALLOWED_ORIGINS: 'https://receipts.example/app' }),
    ).toThrow(/bare origins/);
  });

  it('refuses a non-absolute entry', () => {
    expect(() => loadEnv({ ...VALID_ENV, CORS_ALLOWED_ORIGINS: 'receipts.example' })).toThrow(
      /absolute http\(s\) origin/,
    );
  });
});

describe('TRUST_PROXY', () => {
  it('defaults to false', () => {
    expect(loadEnv(VALID_ENV).trustProxy).toBe(false);
  });

  it('accepts explicit true and false', () => {
    expect(loadEnv({ ...VALID_ENV, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadEnv({ ...VALID_ENV, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
  });

  it('rejects anything else rather than guessing', () => {
    expect(() => loadEnv({ ...VALID_ENV, TRUST_PROXY: 'yes' })).toThrow(
      /must be "true" or "false"/,
    );
  });
});

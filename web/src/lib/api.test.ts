import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchWalletReviewsEnabled,
  parseSubmitFunction,
  prepareReview,
  prepareWalletReview,
} from './api';
import { availableMethods } from './features';

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => impl(url, init));
  vi.stubGlobal('fetch', spy);
  return spy;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

const reviewer = '0x00000000000000000000000000000000000000aa' as const;

describe('parseSubmitFunction', () => {
  it('accepts the three gateway functions', () => {
    expect(parseSubmitFunction('submitFreeReview')).toBe('submitFreeReview');
    expect(parseSubmitFunction('submitPaidReview')).toBe('submitPaidReview');
    expect(parseSubmitFunction('submitWalletReview')).toBe('submitWalletReview');
  });

  it('throws on anything else', () => {
    for (const value of ['submitAnything', '', undefined, null, 3]) {
      expect(() => parseSubmitFunction(value)).toThrow(ApiError);
    }
  });
});

describe('wallet feature flag', () => {
  it('enables the wallet method only on an explicit true', async () => {
    mockFetch(() => json({ enabled: true }));
    expect(await fetchWalletReviewsEnabled()).toBe(true);
    expect(availableMethods(true)).toEqual(['world_id', 'wallet']);
  });

  it('hides the wallet method when disabled, malformed, failing or pending', async () => {
    mockFetch(() => json({ enabled: false }));
    expect(await fetchWalletReviewsEnabled()).toBe(false);
    mockFetch(() => json({ enabled: 'true' }));
    expect(await fetchWalletReviewsEnabled()).toBe(false);
    mockFetch(() => json({ error: 'wallet_reviews_disabled' }, 503));
    expect(await fetchWalletReviewsEnabled()).toBe(false);
    mockFetch(() => {
      throw new Error('offline');
    });
    expect(await fetchWalletReviewsEnabled()).toBe(false);
    expect(availableMethods(false)).toEqual(['world_id']);
    expect(availableMethods(null)).toEqual(['world_id']);
  });
});

describe('request bodies', () => {
  it('wallet prepare sends only the five agreed fields', async () => {
    const spy = mockFetch(() => json({ challenge_id: '0x1' }));
    await prepareWalletReview({
      agentId: '7',
      reviewer,
      value: 80,
      valueDecimals: 0,
      content: 'good',
      // Extra keys a caller might try to smuggle through must be dropped.
      ...({ reviewType: 2, receiptId: '0x0', nullifier: '0x1', requestNonce: 'n' } as object),
    });
    const [url, init] = spy.mock.calls[0] ?? [];
    expect(url).toBe('/api/reviews/wallet/prepare');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['agentId', 'content', 'reviewer', 'value', 'valueDecimals'].sort(),
    );
    expect(body).toMatchObject({ agentId: '7', reviewer, value: 80, valueDecimals: 0 });
  });

  it('the free flow still sends its World ID request nonce', async () => {
    const spy = mockFetch(() => json({ challenge_id: '0x1' }));
    await prepareReview({
      agentId: '7',
      reviewer,
      value: 80,
      valueDecimals: 0,
      reviewType: 0,
      content: 'good',
      requestNonce: 'nonce-1',
    });
    const [url, init] = spy.mock.calls[0] ?? [];
    expect(url).toBe('/api/reviews/prepare');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      reviewType: 0,
      requestNonce: 'nonce-1',
    });
  });
});

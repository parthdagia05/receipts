import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VERIFY_BASE_URL,
  createWorldIdVerifier,
  findVerifiedResult,
} from '../src/worldid/verifyClient.js';
import type { VerifySuccessResponse } from '../src/worldid/verifyClient.js';
import { parseIDKitResult } from '../src/worldid/proof.js';
import { idkitResult } from './proofFixtures.js';
import { VALID_ENV } from './fixtures.js';

const RESULT = parseIDKitResult(idkitResult());

/** A fetch double returning one response, recording what it was called with. */
function stubFetch(response: Response | (() => Promise<Response>)): {
  impl: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return typeof response === 'function' ? response() : response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const verifier = (fetchImpl: typeof fetch, timeoutMs?: number) =>
  createWorldIdVerifier({
    rpId: VALID_ENV.WORLD_RP_ID,
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

describe('createWorldIdVerifier', () => {
  describe('request shape', () => {
    it('posts to the v4 endpoint for the configured RP', async () => {
      const { impl, calls } = stubFetch(json({ success: true, results: [] }));

      await verifier(impl)(RESULT);

      expect(calls[0]?.url).toBe(
        `${DEFAULT_VERIFY_BASE_URL}/api/v4/verify/${VALID_ENV.WORLD_RP_ID}`,
      );
      expect(calls[0]?.init.method).toBe('POST');
    });

    it('forwards the IDKit result verbatim', async () => {
      const { impl, calls } = stubFetch(json({ success: true, results: [] }));

      await verifier(impl)(RESULT);

      // Remapping is how a v4 payload gets mistaken for a legacy one.
      expect(JSON.parse(String(calls[0]?.init.body))).toEqual(RESULT);
    });

    it('honours a custom base URL', async () => {
      const { impl, calls } = stubFetch(json({ success: true, results: [] }));

      await createWorldIdVerifier({
        rpId: VALID_ENV.WORLD_RP_ID,
        fetchImpl: impl,
        baseUrl: 'https://portal.test',
      })(RESULT);

      expect(calls[0]?.url).toBe(`https://portal.test/api/v4/verify/${VALID_ENV.WORLD_RP_ID}`);
    });
  });

  describe('success', () => {
    it('returns the parsed body for a documented 200', async () => {
      const body = {
        success: true,
        results: [{ identifier: 'proof_of_human', success: true, nullifier: '42' }],
      };
      const outcome = await verifier(stubFetch(json(body)).impl)(RESULT);

      expect(outcome.ok).toBe(true);
      expect(outcome.ok && outcome.response).toEqual(body);
    });

    it('accepts a 200 with an empty results array', async () => {
      // Shape-valid; whether our credential verified is a separate question.
      const outcome = await verifier(stubFetch(json({ success: true, results: [] })).impl)(RESULT);

      expect(outcome.ok).toBe(true);
    });
  });

  describe('malformed success bodies', () => {
    it.each([
      ['success false', { success: false, results: [] }],
      ['success missing', { results: [] }],
      ['results missing', { success: true }],
      ['results not an array', { success: true, results: {} }],
      ['a results entry that is not an object', { success: true, results: ['x'] }],
      ['an array body', []],
      ['a string body', 'ok'],
      ['null body', null],
    ])('treats %s as malformed', async (_label, body) => {
      const outcome = await verifier(stubFetch(json(body)).impl)(RESULT);

      expect(outcome).toEqual({ ok: false, failure: { kind: 'malformed' } });
    });

    it('treats non-JSON in a 200 as malformed', async () => {
      const bad = new Response('not json', { status: 200 });
      const outcome = await verifier(stubFetch(bad).impl)(RESULT);

      expect(outcome).toEqual({ ok: false, failure: { kind: 'malformed' } });
    });
  });

  describe('rejections', () => {
    it('reports the status and the API error code', async () => {
      const body = { success: false, code: 'all_verifications_failed', detail: 'proof 0x… bad' };
      const outcome = await verifier(stubFetch(json(body, 400)).impl)(RESULT);

      expect(outcome).toEqual({
        ok: false,
        failure: { kind: 'rejected', status: 400, code: 'all_verifications_failed' },
      });
    });

    it('drops the API detail, which can quote the proof', async () => {
      const detail = 'nullifier 123456789 rejected';
      const outcome = await verifier(
        stubFetch(json({ success: false, code: 'x', detail }, 400)).impl,
      )(RESULT);

      expect(JSON.stringify(outcome)).not.toContain(detail);
      expect(JSON.stringify(outcome)).not.toContain('123456789');
    });

    it('handles a 404 with no code', async () => {
      const outcome = await verifier(stubFetch(json({ success: false }, 404)).impl)(RESULT);

      expect(outcome).toEqual({ ok: false, failure: { kind: 'rejected', status: 404 } });
    });

    it('handles a non-JSON error body', async () => {
      const bad = new Response('<html>502</html>', { status: 502 });
      const outcome = await verifier(stubFetch(bad).impl)(RESULT);

      expect(outcome).toEqual({ ok: false, failure: { kind: 'rejected', status: 502 } });
    });

    it.each([400, 401, 403, 429, 500, 503])('classifies status %i as rejected', async (status) => {
      const outcome = await verifier(stubFetch(json({ success: false }, status)).impl)(RESULT);

      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.failure.kind).toBe('rejected');
    });
  });

  describe('transport failures', () => {
    it('reports a network error as unavailable', async () => {
      const impl = (async () => {
        throw new TypeError('fetch failed: https://developer.world.org/api/v4/verify/rp_secret');
      }) as unknown as typeof fetch;

      const outcome = await verifier(impl)(RESULT);

      expect(outcome).toEqual({ ok: false, failure: { kind: 'unavailable' } });
      // The endpoint and anything else in the provider message stay out of it.
      expect(JSON.stringify(outcome)).not.toContain('rp_secret');
    });

    it('aborts and reports unavailable when the API is slow', async () => {
      const impl = (async (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        })) as unknown as typeof fetch;

      const started = Date.now();
      const outcome = await verifier(impl, 50)(RESULT);

      expect(outcome).toEqual({ ok: false, failure: { kind: 'unavailable' } });
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('times out when headers arrive promptly but the body stalls', async () => {
      // The response is available immediately; reading it never completes. If
      // the timer were cleared on headers, this would hang forever.
      const impl = (async (_url: string, init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      })) as unknown as typeof fetch;

      const started = Date.now();
      const outcome = await verifier(impl, 50)(RESULT);

      // A body that never arrived is a transport failure, not a bad document.
      expect(outcome).toEqual({ ok: false, failure: { kind: 'unavailable' } });
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('reports a body that fails to read without a timeout as malformed', async () => {
      // The read fails but our timer never fired, so this is a bad document
      // rather than a transport failure — the distinction the signal draws.
      const impl = (async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new TypeError('terminated');
        },
      })) as unknown as typeof fetch;

      expect(await verifier(impl, 5_000)(RESULT)).toEqual({
        ok: false,
        failure: { kind: 'malformed' },
      });
    });

    it('still reports invalid JSON on a healthy connection as malformed', async () => {
      const bad = new Response('{ not json', { status: 200 });

      expect(await verifier(stubFetch(bad).impl, 5_000)(RESULT)).toEqual({
        ok: false,
        failure: { kind: 'malformed' },
      });
    });

    it('passes an abort signal so the timeout can fire', async () => {
      const { impl, calls } = stubFetch(json({ success: true, results: [] }));

      await verifier(impl)(RESULT);

      expect(calls[0]?.init.signal).toBeDefined();
    });
  });
});

describe('findVerifiedResult', () => {
  const response = (results: VerifySuccessResponse['results']): VerifySuccessResponse => ({
    success: true,
    results,
  });

  it('finds the matching credential that succeeded', () => {
    const found = findVerifiedResult(
      response([
        { identifier: 'passport', success: true, nullifier: '1' },
        { identifier: 'proof_of_human', success: true, nullifier: '2' },
      ]),
      'proof_of_human',
    );

    expect(found?.nullifier).toBe('2');
  });

  it('ignores a matching credential that failed', () => {
    // The endpoint returns 200 for "at least one proof verified", so a failed
    // entry alongside a successful other credential must not count.
    const found = findVerifiedResult(
      response([
        { identifier: 'proof_of_human', success: false, code: 'verification_error' },
        { identifier: 'passport', success: true },
      ]),
      'proof_of_human',
    );

    expect(found).toBeUndefined();
  });

  it('ignores an entry with no explicit success', () => {
    const found = findVerifiedResult(
      response([{ identifier: 'proof_of_human' }]),
      'proof_of_human',
    );

    expect(found).toBeUndefined();
  });

  it('returns undefined for an empty results array', () => {
    expect(findVerifiedResult(response([]), 'proof_of_human')).toBeUndefined();
  });
});

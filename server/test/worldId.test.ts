import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { IN_MEMORY, openDatabase } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { findWorldIdRequest } from '../src/db/worldIdRequests.js';
import {
  ACTION_PREFIX,
  InvalidAgentIdError,
  parseAgentId,
  reviewAgentAction,
} from '../src/worldid/action.js';
import {
  RpSigningError,
  RpSigningKeyError,
  createRpContextSigner,
} from '../src/worldid/signing.js';
import { VALID_ENV, appDeps, failingRpContextSigner, fakeRpContextSigner } from './fixtures.js';

const ENDPOINT = '/api/world-id/request';

/** POST a JSON body to the request endpoint. */
async function post(app: ReturnType<typeof createApp>, body: unknown): Promise<Response> {
  return app.request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('parseAgentId', () => {
  it.each([
    '1',
    '42',
    '115792089237316195423570985008687907853269984665640564039457584007913129639935',
  ])('accepts %o', (raw) => {
    expect(parseAgentId(raw)).toBe(BigInt(raw));
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 42],
    ['a bigint', 42n],
    ['an object', { agentId: '1' }],
    ['an array', ['1']],
    ['a boolean', true],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseAgentId(raw)).toThrow(InvalidAgentIdError);
  });

  it.each(['', ' ', '4 2', '4.2', '0x2a', '-1', '1e3', 'abc', '42n'])('rejects %o', (raw) => {
    expect(() => parseAgentId(raw)).toThrow(InvalidAgentIdError);
  });

  it('rejects zero', () => {
    expect(() => parseAgentId('0')).toThrow(/greater than zero/);
  });

  it('rejects leading zeros, which would split the nullifier space', () => {
    expect(() => parseAgentId('042')).toThrow(/leading zeros/);
    expect(() => parseAgentId('00')).toThrow(InvalidAgentIdError);
  });

  it('rejects a value above uint256', () => {
    expect(() => parseAgentId((2n ** 256n).toString(10))).toThrow(/uint256/);
  });

  describe('decimal length bounds', () => {
    const UINT256_MAX = 2n ** 256n - 1n;

    it('accepts the exact uint256 maximum (78 digits)', () => {
      const max = UINT256_MAX.toString(10);

      expect(max).toHaveLength(78);
      expect(parseAgentId(max)).toBe(UINT256_MAX);
    });

    it('accepts a 78-digit value inside the range', () => {
      const inRange = (UINT256_MAX - 1n).toString(10);

      expect(inRange).toHaveLength(78);
      expect(parseAgentId(inRange)).toBe(UINT256_MAX - 1n);
    });

    it('rejects a 78-digit value above the range', () => {
      // Same digit count as the maximum, but larger.
      const tooBig = '9'.repeat(78);

      expect(BigInt(tooBig)).toBeGreaterThan(UINT256_MAX);
      expect(() => parseAgentId(tooBig)).toThrow(/uint256/);
    });

    it('rejects a 79-digit value', () => {
      expect(() => parseAgentId('1'.repeat(79))).toThrow(/uint256/);
    });

    it('rejects an absurdly long digit string without parsing it', () => {
      // The length bound must trip before BigInt is handed the string.
      expect(() => parseAgentId('9'.repeat(100_000))).toThrow(/uint256/);
    });
  });

  it('preserves precision beyond Number.MAX_SAFE_INTEGER', () => {
    const big = '9007199254740993'; // 2^53 + 1
    expect(parseAgentId(big).toString(10)).toBe(big);
  });
});

describe('reviewAgentAction', () => {
  it('builds the documented action', () => {
    expect(reviewAgentAction(42n)).toBe('review-agent-42');
    expect(reviewAgentAction(1n)).toBe(`${ACTION_PREFIX}1`);
  });

  it('is the same action for free and paid reviews of one agent', () => {
    // One personhood scope per (human, agent): a per-path action would let the
    // same human post one free and one paid review.
    expect(reviewAgentAction(42n)).toBe(reviewAgentAction(42n));
  });

  it('differs between agents', () => {
    expect(reviewAgentAction(42n)).not.toBe(reviewAgentAction(43n));
  });

  it('emits the canonical decimal', () => {
    expect(reviewAgentAction(BigInt('042'))).toBe('review-agent-42');
  });
});

describe('createRpContextSigner', () => {
  it('maps the SDK result onto the IDKit field names', () => {
    const signer = createRpContextSigner({
      signingKeyHex: VALID_ENV.WORLD_SIGNING_KEY,
      rpId: VALID_ENV.WORLD_RP_ID,
      ttlSeconds: 300,
    });

    const context = signer('review-agent-42');

    expect(Object.keys(context).sort()).toEqual([
      'created_at',
      'expires_at',
      'nonce',
      'rp_id',
      'signature',
    ]);
    expect(context.rp_id).toBe(VALID_ENV.WORLD_RP_ID);
    expect(context.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(context.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(context.expires_at - context.created_at).toBe(300);
  });

  it('never returns the signing key', () => {
    const signer = createRpContextSigner({
      signingKeyHex: VALID_ENV.WORLD_SIGNING_KEY,
      rpId: VALID_ENV.WORLD_RP_ID,
    });

    const serialized = JSON.stringify(signer('review-agent-42'));

    expect(serialized).not.toContain(VALID_ENV.WORLD_SIGNING_KEY);
    expect(serialized).not.toContain(VALID_ENV.WORLD_SIGNING_KEY.slice(2));
  });

  describe('signing key validation at construction', () => {
    const build = (signingKeyHex: string) => () =>
      createRpContextSigner({ signingKeyHex, rpId: VALID_ENV.WORLD_RP_ID });

    it.each([
      ['malformed', 'not-a-hex-key'],
      ['too short', '0x1234'],
      ['31 bytes', `0x${'33'.repeat(31)}`],
      ['33 bytes', `0x${'33'.repeat(33)}`],
      ['non-hex', `0x${'zz'.repeat(32)}`],
      ['empty', ''],
    ])('rejects a %s key when the signer is built', (_label, key) => {
      expect(build(key)).toThrow(RpSigningKeyError);
    });

    it('rejects the zero scalar', () => {
      expect(build(`0x${'00'.repeat(32)}`)).toThrow(RpSigningKeyError);
      expect(build(`0x${'00'.repeat(32)}`)).toThrow(/not a valid secp256k1 scalar/);
    });

    it('rejects a scalar at or above the group order', () => {
      // n itself and n + 1 are both outside [1, n).
      const order = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
      expect(build(`0x${order}`)).toThrow(RpSigningKeyError);
      expect(build(`0x${'ff'.repeat(32)}`)).toThrow(RpSigningKeyError);
    });

    it('accepts a valid scalar, with or without the 0x prefix', () => {
      expect(build(VALID_ENV.WORLD_SIGNING_KEY)).not.toThrow();
      expect(build(VALID_ENV.WORLD_SIGNING_KEY.slice(2))).not.toThrow();
    });

    it('accepts the largest valid scalar, n - 1', () => {
      const orderMinusOne = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140';
      expect(build(`0x${orderMinusOne}`)).not.toThrow();
    });

    it('never includes key material in the rejection', () => {
      const keys = [`0x${'00'.repeat(32)}`, `0x${'ff'.repeat(32)}`, 'not-a-hex-key'];

      for (const key of keys) {
        let message = '';
        try {
          build(key)();
        } catch (err) {
          message = (err as Error).message;
        }

        expect(message).not.toBe('');
        expect(message).not.toContain(key);
        expect(message).not.toContain(key.startsWith('0x') ? key.slice(2) : key);

        // viem reports an out-of-range scalar as a decimal integer.
        if (/^0x[0-9a-f]{64}$/.test(key)) {
          expect(message).not.toContain(BigInt(key).toString(10));
        }
      }
    });
  });

  it('still surfaces a per-request failure as RpSigningError', () => {
    // The construction-time check covers key faults; RpSigningError remains the
    // channel for a failure raised by the SDK during a signing call.
    expect(failingRpContextSigner).toThrow(RpSigningError);
  });
});

describe('POST /api/world-id/request', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('returns app_id, action and rp_context for a valid agentId', async () => {
    const { signer, actions } = fakeRpContextSigner();
    const app = createApp(appDeps(db, { rpContextSigner: signer }));

    const res = await post(app, { agentId: '42' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      app_id: VALID_ENV.WORLD_APP_ID,
      action: 'review-agent-42',
      environment: VALID_ENV.WORLD_ENVIRONMENT,
      rp_context: {
        rp_id: VALID_ENV.WORLD_RP_ID,
        nonce: `0x${'ab'.repeat(32)}`,
        created_at: 1_793_740_542,
        expires_at: 1_793_740_842,
        signature: `0x${'cd'.repeat(65)}`,
      },
    });
    expect(actions).toEqual(['review-agent-42']);
  });

  it('uses the exact rp_context field names IDKit expects', async () => {
    const app = createApp(appDeps(db));
    const body = (await (await post(app, { agentId: '7' })).json()) as {
      rp_context: Record<string, unknown>;
    };

    expect(Object.keys(body.rp_context).sort()).toEqual([
      'created_at',
      'expires_at',
      'nonce',
      'rp_id',
      'signature',
    ]);
    // The SDK's own names must not leak through.
    expect(body.rp_context).not.toHaveProperty('sig');
    expect(body.rp_context).not.toHaveProperty('createdAt');
    expect(body.rp_context).not.toHaveProperty('expiresAt');
  });

  it('returns only the documented top-level fields', async () => {
    const app = createApp(appDeps(db));
    const body = (await (await post(app, { agentId: '7' })).json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      'action',
      'app_id',
      'environment',
      'rp_context',
    ]);
  });

  it('reports the environment the server is configured with, not production by default', async () => {
    const app = createApp(appDeps(db, { worldEnvironment: 'staging' }));
    const body = (await (await post(app, { agentId: '7' })).json()) as Record<string, unknown>;

    expect(body.environment).toBe('staging');
  });

  it('ignores an environment supplied in the request body', async () => {
    // The field is advisory output, never input. A caller that asks to be
    // treated as staging on a production deployment is told "production" --
    // and reviewProof independently rejects any proof whose environment does
    // not match the server's own, so lying here buys nothing.
    const app = createApp(appDeps(db, { worldEnvironment: 'production' }));
    const body = (await (
      await post(app, { agentId: '7', environment: 'staging' })
    ).json()) as Record<string, unknown>;

    expect(body.environment).toBe('production');
  });

  it('derives the same action for free and paid review requests', async () => {
    const { signer, actions } = fakeRpContextSigner();
    const app = createApp(appDeps(db, { rpContextSigner: signer }));

    // Nothing in the request distinguishes the two paths: one action serves both.
    await post(app, { agentId: '42' });
    await post(app, { agentId: '42' });

    expect(actions).toEqual(['review-agent-42', 'review-agent-42']);
  });

  it('signs an arbitrary, never-seen agent action without any registry lookup', async () => {
    // World ID 4.0 scopes the nullifier by (identity, rp_id, action), hashing
    // the action in, so a fresh action string needs no prior Portal entry. The
    // route must therefore reach the signer for any valid agentId.
    const { signer, actions } = fakeRpContextSigner();
    const app = createApp(appDeps(db, { rpContextSigner: signer }));

    const unseen = (2n ** 200n + 7n).toString(10);
    const res = await post(app, { agentId: unseen });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { action: string }).action).toBe(`review-agent-${unseen}`);
    expect(actions).toEqual([`review-agent-${unseen}`]);
  });

  it('derives different actions for different agents', async () => {
    const { signer, actions } = fakeRpContextSigner();
    const app = createApp(appDeps(db, { rpContextSigner: signer }));

    await post(app, { agentId: '42' });
    await post(app, { agentId: '43' });

    expect(actions).toEqual(['review-agent-42', 'review-agent-43']);
    expect(actions[0]).not.toBe(actions[1]);
  });

  describe('client cannot choose the action', () => {
    it.each([
      ['action', { agentId: '42', action: 'attacker-action' }],
      ['rp_context', { agentId: '42', rp_context: { rp_id: 'rp_evil' } }],
      ['app_id', { agentId: '42', app_id: 'app_evil' }],
      ['nested agentId', { agentId: '42', agent: { id: '99' } }],
    ])('ignores a client-supplied %s', async (_label, body) => {
      const { signer, actions } = fakeRpContextSigner();
      const app = createApp(appDeps(db, { rpContextSigner: signer }));

      const res = await post(app, body);
      const json = (await res.json()) as { action: string; app_id: string };

      expect(res.status).toBe(200);
      expect(json.action).toBe('review-agent-42');
      expect(json.app_id).toBe(VALID_ENV.WORLD_APP_ID);
      expect(actions).toEqual(['review-agent-42']);
    });
  });

  describe('invalid agent ids', () => {
    it.each([
      ['missing', {}],
      ['null', { agentId: null }],
      ['a number', { agentId: 42 }],
      ['zero', { agentId: '0' }],
      ['negative', { agentId: '-1' }],
      ['leading zeros', { agentId: '042' }],
      ['non-numeric', { agentId: 'abc' }],
      ['hex', { agentId: '0x2a' }],
      ['fractional', { agentId: '4.2' }],
      ['empty', { agentId: '' }],
      ['above uint256', { agentId: (2n ** 256n).toString(10) }],
    ])('rejects %s with 400', async (_label, body) => {
      const app = createApp(appDeps(db));
      const res = await post(app, body);

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_agent_id' });
    });

    it('does not call the signer for an invalid agentId', async () => {
      const { signer, actions } = fakeRpContextSigner();
      const app = createApp(appDeps(db, { rpContextSigner: signer }));

      await post(app, { agentId: '0' });

      expect(actions).toEqual([]);
    });
  });

  describe('malformed bodies', () => {
    it('rejects a non-JSON body', async () => {
      const app = createApp(appDeps(db));
      const res = await app.request(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_json' });
    });

    it.each([
      ['an array', []],
      ['a string', 'hello'],
      ['a number', 1],
      ['null', null],
    ])('rejects %s body', async (_label, body) => {
      const app = createApp(appDeps(db));
      const res = await post(app, body);

      expect(res.status).toBe(400);
    });

    it('rejects GET', async () => {
      const app = createApp(appDeps(db));

      expect((await app.request(ENDPOINT)).status).toBe(404);
    });
  });

  describe('signing failures', () => {
    it('returns an opaque 500 when signing fails', async () => {
      const app = createApp(appDeps(db, { rpContextSigner: failingRpContextSigner }));
      const res = await post(app, { agentId: '42' });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'signing_failed' });
    });

    it('returns an opaque body carrying no detail', async () => {
      const app = createApp(appDeps(db, { rpContextSigner: failingRpContextSigner }));

      const text = await (await post(app, { agentId: '42' })).text();

      expect(text).toBe(JSON.stringify({ error: 'signing_failed' }));
    });

    it('never builds an app with an invalid signing key', () => {
      // A bad key now fails at startup, so this failure mode cannot reach a
      // request at all.
      expect(() =>
        createRpContextSigner({ signingKeyHex: 'not-a-hex-key', rpId: VALID_ENV.WORLD_RP_ID }),
      ).toThrow(RpSigningKeyError);
    });
  });

  describe('nonce persistence', () => {
    it('records the issued nonce bound to its full context', async () => {
      const { signer } = fakeRpContextSigner();
      const app = createApp(appDeps(db, { rpContextSigner: signer }));

      await post(app, { agentId: '42' });

      expect(findWorldIdRequest(db, `0x${'ab'.repeat(32)}`)).toEqual({
        nonce: `0x${'ab'.repeat(32)}`,
        rpId: VALID_ENV.WORLD_RP_ID,
        action: 'review-agent-42',
        agentId: '42',
        createdAt: 1_793_740_542,
        expiresAt: 1_793_740_842,
        consumedAt: null,
      });
    });

    it('persists before the response is returned', async () => {
      const app = createApp(appDeps(db));

      const res = await post(app, { agentId: '42' });

      // The row exists the moment the caller can observe a 200.
      expect(res.status).toBe(200);
      expect(findWorldIdRequest(db, `0x${'ab'.repeat(32)}`)).toBeDefined();
    });

    it('does not consume the nonce merely by issuing it', async () => {
      const app = createApp(appDeps(db));
      await post(app, { agentId: '42' });

      expect(findWorldIdRequest(db, `0x${'ab'.repeat(32)}`)?.consumedAt).toBeNull();
    });

    it('records nothing when the agentId is rejected', async () => {
      const app = createApp(appDeps(db));

      await post(app, { agentId: '0' });

      expect(db.prepare('SELECT COUNT(*) AS n FROM world_id_requests').get()).toEqual({ n: 0 });
    });

    it('records nothing when signing fails', async () => {
      const app = createApp(appDeps(db, { rpContextSigner: failingRpContextSigner }));

      await post(app, { agentId: '42' });

      expect(db.prepare('SELECT COUNT(*) AS n FROM world_id_requests').get()).toEqual({ n: 0 });
    });

    it('persists a uint256 agentId exactly', async () => {
      const big = (2n ** 256n - 1n).toString(10);
      const app = createApp(appDeps(db));

      await post(app, { agentId: big });

      expect(findWorldIdRequest(db, `0x${'ab'.repeat(32)}`)?.agentId).toBe(big);
    });

    it('fails the request when persistence fails', async () => {
      // A signer that reissues one nonce collides on the second call, which is
      // what a nonce-reuse fault would look like in production.
      const { signer } = fakeRpContextSigner();
      const app = createApp(appDeps(db, { rpContextSigner: signer }));

      expect((await post(app, { agentId: '42' })).status).toBe(200);

      const second = await post(app, { agentId: '43' });

      expect(second.status).toBe(500);
      expect(await second.json()).toEqual({ error: 'request_not_persisted' });
    });

    it('does not return a signed context when persistence fails', async () => {
      const { signer } = fakeRpContextSigner();
      const app = createApp(appDeps(db, { rpContextSigner: signer }));
      await post(app, { agentId: '42' });

      const text = await (await post(app, { agentId: '43' })).text();

      expect(text).toBe(JSON.stringify({ error: 'request_not_persisted' }));
      expect(text).not.toContain('rp_context');
      // The colliding nonce is not echoed either.
      expect(text).not.toContain('ab'.repeat(32));
    });

    it('keeps the first request intact after a collision', async () => {
      const { signer } = fakeRpContextSigner();
      const app = createApp(appDeps(db, { rpContextSigner: signer }));

      await post(app, { agentId: '42' });
      await post(app, { agentId: '43' });

      expect(findWorldIdRequest(db, `0x${'ab'.repeat(32)}`)?.agentId).toBe('42');
      expect(db.prepare('SELECT COUNT(*) AS n FROM world_id_requests').get()).toEqual({ n: 1 });
    });

    it('records one row per distinct request', async () => {
      let n = 0;
      const app = createApp(
        appDeps(db, {
          rpContextSigner: (action) => {
            n += 1;
            return {
              rp_id: VALID_ENV.WORLD_RP_ID,
              nonce: `0x${String(n).padStart(2, '0').repeat(32)}`,
              created_at: 1_793_740_542,
              expires_at: 1_793_740_842,
              signature: `0x${'cd'.repeat(65)}`,
            };
          },
        }),
      );

      await post(app, { agentId: '42' });
      await post(app, { agentId: '43' });

      expect(db.prepare('SELECT COUNT(*) AS n FROM world_id_requests').get()).toEqual({ n: 2 });
    });
  });

  describe('secret confidentiality', () => {
    it('never includes the signing key in a response', async () => {
      const app = createApp(
        appDeps(db, {
          rpContextSigner: createRpContextSigner({
            signingKeyHex: VALID_ENV.WORLD_SIGNING_KEY,
            rpId: VALID_ENV.WORLD_RP_ID,
          }),
        }),
      );

      const text = await (await post(app, { agentId: '42' })).text();

      expect(text).not.toContain(VALID_ENV.WORLD_SIGNING_KEY);
      expect(text).not.toContain(VALID_ENV.WORLD_SIGNING_KEY.slice(2));
      expect(text).not.toContain(VALID_ENV.RECORD_SERVER_PRIVATE_KEY);
    });

    it('logs nothing on the success path', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const app = createApp(appDeps(db));
      await post(app, { agentId: '42' });

      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });
  });
});

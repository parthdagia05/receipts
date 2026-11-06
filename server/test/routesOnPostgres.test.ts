import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import type { Hex } from 'viem';
import { createApp } from '../src/app.js';
import { createPostgresRepository } from '../src/db/postgres/repository.js';
import { reviewContentRoute } from '../src/routes/reviewContent.js';
import { createTestDatabase, skipNotice } from './support/pg.js';
import {
  VALID_ENV,
  fakeRpContextSigner,
  fakeWorldIdVerifier,
  testAttestationSigner,
} from './fixtures.js';

/**
 * The HTTP routes, running against real PostgreSQL.
 *
 * This is the test the migration is actually for. The repository tests prove
 * the backend behaves; these prove the ROUTES behave when it is underneath —
 * same status codes, same response bodies, same error classification. A
 * repository that is individually correct can still break the API if, say,
 * it throws a look-alike error class the route's `instanceof` does not
 * recognise, turning a 400 into a 500. That is not hypothetical: it was a
 * real defect in this implementation, caught before this file existed.
 */

const db = await createTestDatabase('routes', 10);
const describeIf = db.available ? describe : describe.skip;
skipNotice(db.available);

afterAll(async () => {
  await db.close();
});

const hex32 = (label: string): Hex => keccak256(toBytes(label));
const REVIEWER = '0x000000000000000000000000000000000000bEEF';

describeIf('routes on PostgreSQL', () => {
  const repo = createPostgresRepository(db.pool);

  const app = () =>
    createApp({
      repo,
      worldAppId: VALID_ENV.WORLD_APP_ID,
      worldRpId: VALID_ENV.WORLD_RP_ID,
      worldEnvironment: 'production',
      chainId: 11155111,
      reviewGatewayAddress: '0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD',
      reviewContentBaseUrl: 'https://receipts.test',
      rpContextSigner: fakeRpContextSigner().signer,
      worldIdVerifier: fakeWorldIdVerifier().verifier,
      attestationSigner: testAttestationSigner(),
    });

  beforeEach(async () => {
    await db.reset();
  });

  describe('GET /health', () => {
    it('returns 200 and the documented body against a live database', async () => {
      const res = await app().request('/health');
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      // The contract, unchanged from the SQLite implementation.
      expect(body['status']).toBe('ok');
      expect(body['checks']).toEqual({ database: 'ok' });
      expect(typeof body['uptimeSeconds']).toBe('number');
    });

    it('returns 503 when the database is unreachable', async () => {
      const dead = createPostgresRepository({
        connectionString: 'postgres://nobody@127.0.0.1:1/none',
      });
      const res = await createApp({
        repo: dead,
        worldAppId: VALID_ENV.WORLD_APP_ID,
        worldRpId: VALID_ENV.WORLD_RP_ID,
        worldEnvironment: 'production',
        chainId: 11155111,
        reviewGatewayAddress: '0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD',
        reviewContentBaseUrl: 'https://receipts.test',
        rpContextSigner: fakeRpContextSigner().signer,
        worldIdVerifier: fakeWorldIdVerifier().verifier,
        attestationSigner: testAttestationSigner(),
      }).request('/health');

      expect(res.status).toBe(503);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        status: 'degraded',
        checks: { database: 'unreachable' },
      });
      await dead.close();
    });
  });

  describe('POST /api/world-id/request', () => {
    it('mints a request and persists it to PostgreSQL', async () => {
      const res = await app().request('/api/world-id/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: '42' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, Record<string, string>>;
      expect(body['app_id']).toBe(VALID_ENV.WORLD_APP_ID);
      expect(body['action']).toBe('review-agent-42');

      // Recorded before responding: a caller must never hold a signed
      // request the database does not know about.
      const nonce = body['rp_context']?.['nonce'];
      expect(nonce).toBeDefined();
      expect(await repo.findWorldIdRequest(nonce as string)).toBeDefined();
    });

    it('rejects a JSON number agentId, as before', async () => {
      const res = await app().request('/api/world-id/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 42 }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as Record<string, string>).toMatchObject({
        error: 'invalid_agent_id',
      });
    });
  });

  describe('POST /api/reviews/prepare', () => {
    async function verifiedRequest(agentId: string, nullifier: string): Promise<string> {
      const nonce = hex32(`req-${agentId}-${nullifier}-${Date.now()}`);
      await repo.recordWorldIdRequest({
        nonce,
        rpId: VALID_ENV.WORLD_RP_ID,
        action: `review-agent-${agentId}`,
        agentId,
        createdAt: 1000,
        expiresAt: 9_999_999_999,
      });
      await repo.consumeAndRecordVerification({
        nonce,
        rpId: VALID_ENV.WORLD_RP_ID,
        action: `review-agent-${agentId}`,
        agentId,
        reviewer: REVIEWER,
        nullifier,
        now: 2000,
      });
      return nonce;
    }

    const prepare = (body: Record<string, unknown>) =>
      app().request('/api/reviews/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('issues a challenge and returns the documented shape', async () => {
      const requestNonce = await verifiedRequest('50', '5000');
      const res = await prepare({
        agentId: '50',
        reviewer: REVIEWER,
        value: 80,
        valueDecimals: 0,
        reviewType: 0,
        content: 'the agent did what I asked',
        requestNonce,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['challenge_id']).toMatch(/^0x[0-9a-f]{64}$/);
      expect(body['feedback_hash']).toBe(keccak256(toBytes('the agent did what I asked')));
      expect(body['typed_data']).toBeDefined();
      expect(typeof body['deadline']).toBe('number');
    });

    it('stores the review content so the signed URI resolves', async () => {
      const requestNonce = await verifiedRequest('51', '5100');
      await prepare({
        agentId: '51',
        reviewer: REVIEWER,
        value: 90,
        valueDecimals: 0,
        reviewType: 0,
        content: 'stored by prepare',
        requestNonce,
      });

      const hash = keccak256(toBytes('stored by prepare'));
      const res = await reviewContentRoute({ repo }).request(`/reviews/${hash}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('stored by prepare');
    });

    it('returns 404 for an unknown verification', async () => {
      const res = await prepare({
        agentId: '52',
        reviewer: REVIEWER,
        value: 80,
        valueDecimals: 0,
        reviewType: 0,
        content: 'x',
        requestNonce: hex32('no-such-request'),
      });
      expect(res.status).toBe(404);
      expect((await res.json()) as Record<string, string>).toEqual({
        error: 'unknown_verification',
      });
    });

    it('returns 400 when the agent does not match the verification', async () => {
      const requestNonce = await verifiedRequest('53', '5300');
      const res = await prepare({
        agentId: '54',
        reviewer: REVIEWER,
        value: 80,
        valueDecimals: 0,
        reviewType: 0,
        content: 'x',
        requestNonce,
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as Record<string, string>).toEqual({
        error: 'verification_agent_mismatch',
      });
    });

    it('returns 409 once the verification has been authorized', async () => {
      // The status code depends on the route recognising
      // AuthorizationBindingError via `instanceof`. A PostgreSQL
      // implementation throwing a look-alike class would 500 here.
      const requestNonce = await verifiedRequest('55', '5500');
      const first = await prepare({
        agentId: '55',
        reviewer: REVIEWER,
        value: 80,
        valueDecimals: 0,
        reviewType: 0,
        content: 'first',
        requestNonce,
      });
      const challengeId = ((await first.json()) as Record<string, string>)['challenge_id'];

      await repo.consumeReviewAuthorization({
        nonce: challengeId as string,
        signature: hex32('sig') as Hex,
        now: 3000,
      });

      const second = await prepare({
        agentId: '55',
        reviewer: REVIEWER,
        value: 70,
        valueDecimals: 0,
        reviewType: 0,
        content: 'second',
        requestNonce,
      });

      expect(second.status).toBe(409);
      expect((await second.json()) as Record<string, string>).toEqual({
        error: 'verification_already_authorized',
      });
    });
  });

  describe('POST /api/reviews/attest', () => {
    const attest = (body: Record<string, unknown>) =>
      app().request('/api/reviews/attest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('returns 404 for an unknown challenge', async () => {
      const res = await attest({ challengeId: hex32('nope'), signature: '0xabcd' });
      expect(res.status).toBe(404);
      expect((await res.json()) as Record<string, string>).toEqual({ error: 'unknown_challenge' });
    });

    it('rejects a malformed challenge id with 400', async () => {
      const res = await attest({ challengeId: 'not-hex', signature: '0xabcd' });
      expect(res.status).toBe(400);
      expect((await res.json()) as Record<string, string>).toMatchObject({
        error: 'invalid_challenge_id',
      });
    });
  });

  describe('GET /reviews/:feedbackHash', () => {
    it('serves stored content verbatim with the documented headers', async () => {
      const content = toBytes('published review text');
      await repo.putReviewContent({ content, createdAt: 5000 });

      const res = await reviewContentRoute({ repo }).request(`/reviews/${keccak256(content)}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('published review text');
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('returns the same 404 body for a malformed and an absent hash', async () => {
      const malformed = await reviewContentRoute({ repo }).request('/reviews/not-a-hash');
      const absent = await reviewContentRoute({ repo }).request(`/reviews/${hex32('absent')}`);
      expect(malformed.status).toBe(404);
      expect(absent.status).toBe(404);
      expect(await malformed.json()).toEqual({ error: 'not_found' });
      expect(await absent.json()).toEqual({ error: 'not_found' });
    });
  });

  describe('graceful shutdown', () => {
    it('closing the repository drains the pool', async () => {
      const { createPool } = await import('../src/db/postgres/pool.js');
      const pool = createPool({
        connectionString:
          process.env['TEST_DATABASE_URL'] ??
          `postgres://${process.env['USER'] ?? 'postgres'}@localhost:5432/receipts_test`,
      });
      const owned = createPostgresRepository(pool);

      await pool.query('SELECT 1');
      expect(pool.totalCount).toBeGreaterThan(0);

      await owned.close();

      // Ended, so sockets are released rather than left for the database to
      // time out. A query afterwards must fail rather than silently reconnect.
      expect(pool.totalCount).toBe(0);
      await expect(pool.query('SELECT 1')).rejects.toThrow();
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { getAddress } from 'viem';
import { createApp } from '../src/app.js';
import { IN_MEMORY, openDatabase } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { findWorldIdRequest, recordWorldIdRequest } from '../src/db/worldIdRequests.js';
import { findVerificationByNonce, hasReviewed } from '../src/db/worldIdVerifications.js';
import type { VerifyOutcome, WorldIdVerifier } from '../src/worldid/verifyClient.js';
import { VALID_ENV, appDeps, fakeWorldIdVerifier } from './fixtures.js';
import { FIXTURE_NONCE, FIXTURE_REVIEWER, idkitResult, proofItem } from './proofFixtures.js';

const ENDPOINT = '/api/reviews/verify';
const NOW = 1_793_740_600;
const EXPIRES = 1_793_740_842;
const NULLIFIER = '123456789012345678901234567890';

/** A successful verification naming `nullifier`, echoing `action`. */
function verified(nullifier = NULLIFIER, action = 'review-agent-42'): VerifyOutcome {
  return {
    ok: true,
    response: {
      success: true,
      results: [{ identifier: 'proof_of_human', success: true, nullifier }],
      action,
      environment: 'production',
    },
  };
}

describe('POST /api/reviews/verify', () => {
  let db: Db;

  /** Issue the RP request the default proof answers. */
  function issueRequest(overrides: Record<string, unknown> = {}): void {
    recordWorldIdRequest(db, {
      nonce: FIXTURE_NONCE,
      rpId: VALID_ENV.WORLD_RP_ID,
      action: 'review-agent-42',
      agentId: '42',
      createdAt: NOW - 100,
      expiresAt: EXPIRES,
      ...overrides,
    } as never);
  }

  function buildApp(overrides: Parameters<typeof appDeps>[1] = {}) {
    return createApp(appDeps(db, { now: () => NOW, ...overrides }));
  }

  async function post(app: ReturnType<typeof createApp>, body: unknown): Promise<Response> {
    return app.request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** The default, fully valid submission. */
  function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { agentId: '42', reviewer: FIXTURE_REVIEWER, proof: idkitResult(), ...overrides };
  }

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  describe('valid proof', () => {
    it('verifies, consumes the nonce and records the result', async () => {
      issueRequest();
      const { verifier, calls } = fakeWorldIdVerifier(verified());
      const app = buildApp({ worldIdVerifier: verifier });

      const res = await post(app, submission());

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        agent_id: '42',
        reviewer: FIXTURE_REVIEWER,
        nullifier: NULLIFIER,
        verified_at: NOW,
      });

      expect(calls).toHaveLength(1);
      expect(findWorldIdRequest(db, FIXTURE_NONCE)?.consumedAt).toBe(NOW);
      expect(findVerificationByNonce(db, FIXTURE_NONCE)).toEqual({
        nonce: FIXTURE_NONCE,
        agentId: '42',
        reviewer: FIXTURE_REVIEWER,
        nullifier: NULLIFIER,
        verifiedAt: NOW,
      });
    });

    it('forwards the complete IDKit result unchanged', async () => {
      issueRequest();
      const { verifier, calls } = fakeWorldIdVerifier(verified());
      const app = buildApp({ worldIdVerifier: verifier });

      await post(app, submission());

      const forwarded = calls[0] as Record<string, unknown>;
      expect(forwarded['protocol_version']).toBe('4.0');
      expect(forwarded['nonce']).toBe(FIXTURE_NONCE);
      expect(forwarded['action']).toBe('review-agent-42');
      expect(forwarded['environment']).toBe('production');
      expect(forwarded['responses']).toHaveLength(1);
    });

    it('accepts a lowercase reviewer address and stores it checksummed', async () => {
      issueRequest();
      const app = buildApp({ worldIdVerifier: fakeWorldIdVerifier(verified()).verifier });

      const res = await post(app, submission({ reviewer: FIXTURE_REVIEWER.toLowerCase() }));

      expect(res.status).toBe(200);
      expect(findVerificationByNonce(db, FIXTURE_NONCE)?.reviewer).toBe(FIXTURE_REVIEWER);
    });

    it('uses the nullifier the API returned, not the one the client sent', async () => {
      issueRequest();
      const apiNullifier = '999999999999999999';
      const app = buildApp({
        worldIdVerifier: fakeWorldIdVerifier(verified(apiNullifier)).verifier,
      });

      // The client's proof claims a different nullifier.
      const res = await post(
        app,
        submission({ proof: idkitResult({ responses: [proofItem({ nullifier: '111' })] }) }),
      );

      expect(res.status).toBe(200);
      expect(findVerificationByNonce(db, FIXTURE_NONCE)?.nullifier).toBe(apiNullifier);
    });
  });

  describe('local checks run before the proof is forwarded', () => {
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
      ['a wrong action', { proof: idkitResult({ action: 'review-agent-99' }) }, 'action_mismatch'],
      [
        'a staging proof',
        { proof: idkitResult({ environment: 'staging' }) },
        'environment_mismatch',
      ],
      [
        'a missing credential',
        {
          proof: idkitResult({
            responses: [proofItem({ identifier: 'passport', issuer_schema_id: 9303 })],
          }),
        },
        'missing_proof_of_human',
      ],
      [
        'a signal for another wallet',
        {
          proof: idkitResult({
            responses: [proofItem({ signal_hash: hashSignal(getAddress(`0x${'cd'.repeat(20)}`)) })],
          }),
        },
        'signal_mismatch',
      ],
      [
        'an unbound proof',
        { proof: idkitResult({ responses: [proofItem({ signal_hash: undefined })] }) },
        'signal_mismatch',
      ],
    ];

    it.each(cases)('rejects %s without calling the API', async (_label, overrides, error) => {
      issueRequest();
      const { verifier, calls } = fakeWorldIdVerifier(verified());
      const app = buildApp({ worldIdVerifier: verifier });

      const res = await post(app, submission(overrides));

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error });
      expect(calls).toEqual([]);
      expect(findWorldIdRequest(db, FIXTURE_NONCE)?.consumedAt).toBeNull();
    });
  });

  describe('the RP request is checked before the API is called', () => {
    const cases: ReadonlyArray<
      readonly [string, Record<string, unknown> | undefined, number, string]
    > = [
      ['an unknown nonce', undefined, 400, 'unknown_request'],
      ['an expired request', { expiresAt: NOW - 1 }, 400, 'request_expired'],
      ['a request at its exact expiry', { expiresAt: NOW }, 400, 'request_expired'],
      [
        'a request for another agent',
        { agentId: '99', action: 'review-agent-99' },
        400,
        'request_context_mismatch',
      ],
      ['a request under another RP', { rpId: 'rp_other' }, 400, 'request_context_mismatch'],
    ];

    it.each(cases)(
      'rejects %s without calling the verifier',
      async (_label, overrides, status, error) => {
        if (overrides !== undefined) issueRequest(overrides);
        const { verifier, calls } = fakeWorldIdVerifier(verified());
        const app = buildApp({ worldIdVerifier: verifier });

        const res = await post(app, submission());

        expect(res.status).toBe(status);
        expect(await res.json()).toMatchObject({ error });
        // The point of the pre-check: no external call was made.
        expect(calls).toEqual([]);
      },
    );

    it('does not call the verifier for an already-consumed request', async () => {
      issueRequest();
      const first = fakeWorldIdVerifier(verified());
      const app = buildApp({ worldIdVerifier: first.verifier });
      expect((await post(app, submission())).status).toBe(200);
      expect(first.calls).toHaveLength(1);

      // Second submission of the same nonce: refused before the API.
      const second = fakeWorldIdVerifier(verified());
      const retryApp = buildApp({ worldIdVerifier: second.verifier });
      const res = await post(retryApp, submission());

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'request_already_used' });
      expect(second.calls).toEqual([]);
    });

    it('still calls the verifier when the request is usable', async () => {
      issueRequest();
      const { verifier, calls } = fakeWorldIdVerifier(verified());
      const app = buildApp({ worldIdVerifier: verifier });

      expect((await post(app, submission())).status).toBe(200);
      expect(calls).toHaveLength(1);
    });
  });

  describe('expiry is re-evaluated after verification', () => {
    it('rejects a request that expires while the verifier is running', async () => {
      issueRequest({ expiresAt: NOW + 10 });

      // The clock advances past expiry during the network round trip, which is
      // exactly the window a single pre-verification reading would miss.
      let clock = NOW;
      const verifier: WorldIdVerifier = async () => {
        clock = NOW + 11;
        return verified();
      };

      const app = createApp(appDeps(db, { now: () => clock, worldIdVerifier: verifier }));
      const res = await post(app, submission());

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'request_expired' });

      // The proof verified, but the request was spent against nothing.
      expect(findWorldIdRequest(db, FIXTURE_NONCE)?.consumedAt).toBeNull();
      expect(findVerificationByNonce(db, FIXTURE_NONCE)).toBeUndefined();
      expect(db.prepare('SELECT COUNT(*) AS n FROM world_id_verifications').get()).toEqual({
        n: 0,
      });
    });

    it('rejects a request that expires exactly as verification completes', async () => {
      issueRequest({ expiresAt: NOW + 10 });

      let clock = NOW;
      const verifier: WorldIdVerifier = async () => {
        // Expiry is exclusive, so landing on expires_at is already too late.
        clock = NOW + 10;
        return verified();
      };

      const app = createApp(appDeps(db, { now: () => clock, worldIdVerifier: verifier }));

      expect((await post(app, submission())).status).toBe(400);
      expect(findWorldIdRequest(db, FIXTURE_NONCE)?.consumedAt).toBeNull();
    });

    it('still succeeds when the clock advances but stays inside the window', async () => {
      issueRequest({ expiresAt: NOW + 100 });

      let clock = NOW;
      const verifier: WorldIdVerifier = async () => {
        clock = NOW + 5;
        return verified();
      };

      const app = createApp(appDeps(db, { now: () => clock, worldIdVerifier: verifier }));
      const res = await post(app, submission());

      expect(res.status).toBe(200);
      // The record carries the post-verification reading, not the pre-check one.
      expect(await res.json()).toMatchObject({ verified_at: NOW + 5 });
      expect(findWorldIdRequest(db, FIXTURE_NONCE)?.consumedAt).toBe(NOW + 5);
    });

    it('still rejects at the pre-check when already expired', async () => {
      // The advisory check keeps its own reading; an already-dead request must
      // not reach the verifier at all.
      issueRequest({ expiresAt: NOW - 1 });
      const { verifier, calls } = fakeWorldIdVerifier(verified());
      const app = buildApp({ worldIdVerifier: verifier });

      expect((await post(app, submission())).status).toBe(400);
      expect(calls).toEqual([]);
    });
  });

  describe('nonce state', () => {
    it('rejects an unknown nonce', async () => {
      // No request issued.
      const app = buildApp({ worldIdVerifier: fakeWorldIdVerifier(verified()).verifier });

      const res = await post(app, submission());

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'unknown_request' });
    });

    it('rejects an expired nonce', async () => {
      issueRequest({ expiresAt: NOW - 1 });
      const app = buildApp({ worldIdVerifier: fakeWorldIdVerifier(verified()).verifier });

      const res = await post(app, submission());

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'request_expired' });
      expect(findVerificationByNonce(db, FIXTURE_NONCE)).toBeUndefined();
    });

    it('rejects a nonce issued for a different agent', async () => {
      issueRequest({ agentId: '99', action: 'review-agent-99' });
      const app = buildApp({ worldIdVerifier: fakeWorldIdVerifier(verified()).verifier });

      const res = await post(app, submission());

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'request_context_mismatch' });
    });

    it('rejects a nonce issued under a different RP', async () => {
      issueRequest({ rpId: 'rp_someone_else' });
      const app = buildApp({ worldIdVerifier: fakeWorldIdVerifier(verified()).verifier });

      const res = await post(app, submission());

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'request_context_mismatch' });
    });

    it('rejects a reused nonce', async () => {
      issueRequest();
      const app = buildApp({ worldIdVerifier: fakeWorldIdVerifier(verified()).verifier });

      expect((await post(app, submission())).status).toBe(200);

      const second = await post(app, submission());
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ error: 'request_already_used' });
    });

    it('consumes the nonce exactly once across repeated submissions', async () => {
      issueRequest();
      const app = buildApp({ worldIdVerifier: fakeWorldIdVerifier(verified()).verifier });

      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        statuses.push((await post(app, submission())).status);
      }

      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM world_id_verifications').get()).toEqual({
        n: 1,
      });
    });
  });

  describe('API failures leave the nonce unspent', () => {
    const failures: ReadonlyArray<readonly [string, VerifyOutcome, number, string]> = [
      [
        'a rejected proof',
        { ok: false, failure: { kind: 'rejected', status: 400, code: 'all_verifications_failed' } },
        400,
        'proof_rejected',
      ],
      [
        'a timeout',
        { ok: false, failure: { kind: 'unavailable' } },
        503,
        'verification_unavailable',
      ],
      [
        'a malformed response',
        { ok: false, failure: { kind: 'malformed' } },
        502,
        'verification_malformed',
      ],
    ];

    it.each(failures)('handles %s', async (_label, outcome, status, error) => {
      issueRequest();
      const app = buildApp({ worldIdVerifier: fakeWorldIdVerifier(outcome).verifier });

      const res = await post(app, submission());

      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ error });

      // The request stays usable: the proof was never verified.
      expect(findWorldIdRequest(db, FIXTURE_NONCE)?.consumedAt).toBeNull();
      expect(findVerificationByNonce(db, FIXTURE_NONCE)).toBeUndefined();
    });

    it('passes on the API error code but no detail', async () => {
      issueRequest();
      const app = buildApp({
        worldIdVerifier: fakeWorldIdVerifier({
          ok: false,
          failure: { kind: 'rejected', status: 400, code: 'app_not_migrated' },
        }).verifier,
      });

      expect(await (await post(app, submission())).json()).toEqual({
        error: 'proof_rejected',
        code: 'app_not_migrated',
      });
    });
  });

  describe('success response must still confirm the credential', () => {
    it('rejects a 200 whose proof_of_human entry failed', async () => {
      // 200 means "at least one proof verified"; ours may not be the one.
      issueRequest();
      const app = buildApp({
        worldIdVerifier: fakeWorldIdVerifier({
          ok: true,
          response: {
            success: true,
            results: [
              { identifier: 'proof_of_human', success: false, code: 'verification_error' },
              { identifier: 'passport', success: true, nullifier: '7' },
            ],
          },
        }).verifier,
      });

      const res = await post(app, submission());

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'proof_of_human_not_verified' });
      expect(findWorldIdRequest(db, FIXTURE_NONCE)?.consumedAt).toBeNull();
    });

    it('rejects a 200 with no matching credential entry', async () => {
      issueRequest();
      const app = buildApp({
        worldIdVerifier: fakeWorldIdVerifier({
          ok: true,
          response: { success: true, results: [{ identifier: 'passport', success: true }] },
        }).verifier,
      });

      expect((await post(app, submission())).status).toBe(400);
    });

    it('rejects a verified entry carrying no nullifier', async () => {
      issueRequest();
      const app = buildApp({
        worldIdVerifier: fakeWorldIdVerifier({
          ok: true,
          response: { success: true, results: [{ identifier: 'proof_of_human', success: true }] },
        }).verifier,
      });

      const res = await post(app, submission());

      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: 'verification_malformed' });
    });

    it('accepts a hex nullifier from the API, which is what World sends', async () => {
      issueRequest();
      const app = buildApp({
        worldIdVerifier: fakeWorldIdVerifier(verified(`0x${'ab'.repeat(32)}`)).verifier,
      });

      expect((await post(app, submission())).status).toBe(200);
    });

    it('stores the nullifier in canonical decimal, whatever encoding arrived', async () => {
      // There is exactly one write point for a nullifier, and every consumer
      // -- reviewPrepare's nullifierToBytes32 among them, for both free and
      // paid reviews -- reads it back from here. Storing the hex verbatim
      // would break that conversion and would let one human hold two rows.
      issueRequest();
      const app = buildApp({
        worldIdVerifier: fakeWorldIdVerifier(verified(`0x${'ab'.repeat(32)}`)).verifier,
      });

      expect((await post(app, submission())).status).toBe(200);

      const row = db.prepare('SELECT nullifier FROM world_id_verifications').get() as {
        nullifier: string;
      };
      expect(row.nullifier).toBe(BigInt(`0x${'ab'.repeat(32)}`).toString(10));
      expect(row.nullifier).toMatch(/^[0-9]+$/);
    });

    it('rejects a 79-digit decimal nullifier from the API without storing it', async () => {
      issueRequest();
      const app = buildApp({
        worldIdVerifier: fakeWorldIdVerifier(verified('1'.repeat(79))).verifier,
      });

      expect((await post(app, submission())).status).toBe(502);
      const count = db.prepare('SELECT count(*) AS n FROM world_id_verifications').get() as {
        n: number;
      };
      expect(count.n).toBe(0);
    });

    it('rejects a nullifier that is not a field element', async () => {
      issueRequest();
      const app = buildApp({
        worldIdVerifier: fakeWorldIdVerifier(verified('not-a-number')).verifier,
      });

      expect((await post(app, submission())).status).toBe(502);
    });

    it('accepts a response omitting the optional action and environment', async () => {
      // Both are optional in the schema, so absence must not fail.
      issueRequest();
      const app = buildApp({
        worldIdVerifier: fakeWorldIdVerifier({
          ok: true,
          response: {
            success: true,
            results: [{ identifier: 'proof_of_human', success: true, nullifier: NULLIFIER }],
          },
        }).verifier,
      });

      expect((await post(app, submission())).status).toBe(200);
    });

    it('rejects a response whose echoed environment disagrees', async () => {
      issueRequest();
      const app = buildApp({
        worldIdVerifier: fakeWorldIdVerifier({
          ok: true,
          response: {
            success: true,
            results: [{ identifier: 'proof_of_human', success: true, nullifier: NULLIFIER }],
            environment: 'staging',
          },
        }).verifier,
      });

      expect(await (await post(app, submission())).json()).toMatchObject({
        error: 'environment_mismatch',
      });
    });

    it('rejects a response whose echoed action disagrees', async () => {
      issueRequest();
      const app = buildApp({
        worldIdVerifier: fakeWorldIdVerifier({
          ok: true,
          response: {
            success: true,
            results: [{ identifier: 'proof_of_human', success: true, nullifier: NULLIFIER }],
            action: 'review-agent-99',
          },
        }).verifier,
      });

      expect(await (await post(app, submission())).json()).toMatchObject({
        error: 'action_mismatch',
      });
    });
  });

  describe('one review per human per agent', () => {
    it('rejects a second agent review from the same nullifier', async () => {
      issueRequest();
      const app = buildApp({ worldIdVerifier: fakeWorldIdVerifier(verified()).verifier });
      expect((await post(app, submission())).status).toBe(200);

      // A fresh request, same human, same agent.
      const secondNonce = `0x${'cd'.repeat(32)}`;
      recordWorldIdRequest(db, {
        nonce: secondNonce,
        rpId: VALID_ENV.WORLD_RP_ID,
        action: 'review-agent-42',
        agentId: '42',
        createdAt: NOW,
        expiresAt: EXPIRES,
      });

      const res = await post(app, submission({ proof: idkitResult({ nonce: secondNonce }) }));

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'already_reviewed' });

      // The rollback leaves the second request unspent and unrecorded.
      expect(findWorldIdRequest(db, secondNonce)?.consumedAt).toBeNull();
      expect(findVerificationByNonce(db, secondNonce)).toBeUndefined();
      expect(db.prepare('SELECT COUNT(*) AS n FROM world_id_verifications').get()).toEqual({
        n: 1,
      });
    });

    it('allows the same human to review a different agent', async () => {
      issueRequest();
      const app = buildApp({ worldIdVerifier: fakeWorldIdVerifier(verified()).verifier });
      expect((await post(app, submission())).status).toBe(200);

      const otherNonce = `0x${'cd'.repeat(32)}`;
      recordWorldIdRequest(db, {
        nonce: otherNonce,
        rpId: VALID_ENV.WORLD_RP_ID,
        action: 'review-agent-43',
        agentId: '43',
        createdAt: NOW,
        expiresAt: EXPIRES,
      });

      const otherApp = buildApp({
        worldIdVerifier: fakeWorldIdVerifier(verified(NULLIFIER, 'review-agent-43')).verifier,
      });
      const res = await post(otherApp, {
        agentId: '43',
        reviewer: FIXTURE_REVIEWER,
        proof: idkitResult({ nonce: otherNonce, action: 'review-agent-43' }),
      });

      expect(res.status).toBe(200);
      expect(hasReviewed(db, '42', NULLIFIER)).toBe(true);
      expect(hasReviewed(db, '43', NULLIFIER)).toBe(true);
    });
  });

  describe('request validation', () => {
    it('rejects a non-JSON body', async () => {
      const app = buildApp();
      const res = await app.request(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_json' });
    });

    it.each([
      [
        'a missing agentId',
        { reviewer: FIXTURE_REVIEWER, proof: idkitResult() },
        'invalid_agent_id',
      ],
      [
        'a numeric agentId',
        { agentId: 42, reviewer: FIXTURE_REVIEWER, proof: idkitResult() },
        'invalid_agent_id',
      ],
      [
        'a zero agentId',
        { agentId: '0', reviewer: FIXTURE_REVIEWER, proof: idkitResult() },
        'invalid_agent_id',
      ],
      ['a missing reviewer', { agentId: '42', proof: idkitResult() }, 'invalid_reviewer'],
      [
        'a malformed reviewer',
        { agentId: '42', reviewer: '0xdead', proof: idkitResult() },
        'invalid_reviewer',
      ],
      ['a missing proof', { agentId: '42', reviewer: FIXTURE_REVIEWER }, 'invalid_proof_payload'],
    ])('rejects %s', async (_label, body, error) => {
      const app = buildApp();
      const res = await post(app, body);

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error });
    });

    it('rejects GET', async () => {
      const app = buildApp();
      expect((await app.request(ENDPOINT)).status).toBe(404);
    });
  });

  describe('confidentiality', () => {
    it('leaks no proof contents, nullifier or secrets on rejection', async () => {
      issueRequest();
      const app = buildApp({
        worldIdVerifier: fakeWorldIdVerifier({
          ok: false,
          failure: { kind: 'rejected', status: 400, code: 'all_verifications_failed' },
        }).verifier,
      });

      const text = await (await post(app, submission())).text();

      expect(text).not.toContain(NULLIFIER);
      expect(text).not.toContain(hashSignal(FIXTURE_REVIEWER));
      expect(text).not.toContain(VALID_ENV.WORLD_SIGNING_KEY);
      expect(text).not.toContain(VALID_ENV.RECORD_SERVER_PRIVATE_KEY);
      expect(text).not.toContain(VALID_ENV.RPC_URL);
    });

    it('logs nothing on the success path', async () => {
      issueRequest();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const app = buildApp({ worldIdVerifier: fakeWorldIdVerifier(verified()).verifier });
      await post(app, submission());

      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    it('logs nothing when a proof is rejected', async () => {
      issueRequest();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const app = buildApp({
        worldIdVerifier: fakeWorldIdVerifier({ ok: false, failure: { kind: 'unavailable' } })
          .verifier,
      });
      await post(app, submission());

      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });
  });
});

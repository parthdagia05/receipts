import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { createApp } from '../src/app.js';
import { IN_MEMORY, openDatabase } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { findReviewAuthorization } from '../src/db/reviewAuthorizations.js';
import { REVIEW_TYPE } from '../src/signing/reviewContent.js';
import { DEFAULT_ATTESTATION_TTL_SECONDS } from '../src/routes/reviewAttest.js';
import type { VerifyOutcome, WorldIdVerifier } from '../src/worldid/verifyClient.js';
import type { RpContextSigner } from '../src/worldid/signing.js';
import { VALID_ENV, appDeps } from './fixtures.js';

/**
 * Whether a reviewer can recover an attestation after it has become unusable.
 *
 * This is the precondition the F-05 migration strategy rests on. Adding a
 * signed `issuedAt` changes the EIP-712 digest, so a replacement gateway
 * rejects every attestation minted under the old schema. Those holders must be
 * able to get a new one — and they cannot simply start over: `/attest` consumes
 * the challenge, and `UNIQUE (agent_id, nullifier)` on world_id_verifications
 * blocks a second World ID verification for the same agent. Without a working
 * replay they would be permanently unable to review that agent.
 *
 * The recovery path is re-posting the identical `(challengeId, signature)`,
 * which `consumeReviewAuthorization` treats as an idempotent retry rather than
 * a conflict. The route re-reads the clock afterwards, so the retry is signed
 * fresh. Nothing here weakens that: a *different* signature on a spent
 * challenge is still a conflict, and the one-human-one-review guard is asserted
 * to survive.
 */

const AGENT_ID = '9007199254740993';
const SECOND_AGENT_ID = '4242';
const NULLIFIER_DECIMAL = '98765432109876543210987654321098765432109876543210';

const REVIEWER_KEY: Hex = `0x${'7a'.repeat(32)}`;
const REVIEWER = privateKeyToAddress(REVIEWER_KEY);
const OTHER_KEY: Hex = `0x${'5b'.repeat(32)}`;

const CONTENT = 'Settled the refund without being asked twice.';
const VALUE = 73;
const START = 1_793_740_600;

interface RequestBody {
  action: string;
  rp_context: { nonce: string };
}
interface PrepareBody {
  challenge_id: Hex;
  deadline: number;
  feedback_hash: Hex;
  typed_data: {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  };
}
interface AttestBody {
  attestation: Record<string, unknown> & { signature: Hex };
  submit_function: string;
}

describe('recovering an attestation after it becomes unusable', () => {
  let db: Db;
  /** Mutable so the deadline and a cutover can be moved past. */
  let now: number;
  let rpSigner: RpContextSigner;

  function portal(nullifier = NULLIFIER_DECIMAL): WorldIdVerifier {
    return async (result) => {
      const outcome: VerifyOutcome = {
        ok: true,
        response: {
          success: true,
          results: [{ identifier: 'proof_of_human', success: true, nullifier }],
          action: result.action,
          environment: result.environment,
        },
      };
      return outcome;
    };
  }

  function makeRpSigner(): RpContextSigner {
    let issued = 0;
    return () => {
      issued += 1;
      return {
        rp_id: VALID_ENV.WORLD_RP_ID,
        nonce: `0x${issued.toString(16).padStart(4, '0').repeat(16)}`,
        created_at: now - 60,
        expires_at: now + 240,
        signature: `0x${'cd'.repeat(65)}`,
      };
    };
  }

  function app(nullifier = NULLIFIER_DECIMAL) {
    return createApp(
      appDeps(db, {
        now: () => now,
        worldIdVerifier: portal(nullifier),
        rpContextSigner: rpSigner,
      }),
    );
  }

  async function post(
    instance: ReturnType<typeof createApp>,
    path: string,
    body: unknown,
  ): Promise<Response> {
    return instance.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function proofFor(nonce: string, action: string, reviewer: Address): Record<string, unknown> {
    return {
      protocol_version: '4.0',
      nonce,
      action,
      environment: 'production',
      responses: [
        {
          identifier: 'proof_of_human',
          issuer_schema_id: 1,
          nullifier: NULLIFIER_DECIMAL,
          proof: ['1', '2', '3', '4', '5'],
          expires_at_min: now + 86_400,
          signal_hash: hashSignal(reviewer),
        },
      ],
    };
  }

  /** Steps 1-3: verify a human, prepare a review, sign the served typed data. */
  async function prepareAndSign(
    agentId = AGENT_ID,
    nullifier = NULLIFIER_DECIMAL,
    signerKey: Hex = REVIEWER_KEY,
  ): Promise<{ prepare: PrepareBody; signature: Hex }> {
    const instance = app(nullifier);

    const request = (await (
      await post(instance, '/api/world-id/request', { agentId })
    ).json()) as RequestBody;

    const verifyRes = await post(instance, '/api/reviews/verify', {
      agentId,
      reviewer: REVIEWER,
      proof: proofFor(request.rp_context.nonce, request.action, REVIEWER),
    });
    expect(verifyRes.status).toBe(200);

    const prepareRes = await post(instance, '/api/reviews/prepare', {
      agentId,
      reviewer: REVIEWER,
      requestNonce: request.rp_context.nonce,
      value: VALUE,
      valueDecimals: 0,
      reviewType: REVIEW_TYPE.FREE,
      content: CONTENT,
    });
    expect(prepareRes.status).toBe(200);
    const prepare = (await prepareRes.json()) as PrepareBody;

    const signature = await privateKeyToAccount(signerKey).signTypedData({
      domain: prepare.typed_data.domain,
      types: prepare.typed_data.types,
      primaryType: prepare.typed_data.primaryType,
      message: prepare.typed_data.message,
    } as never);

    return { prepare, signature };
  }

  const attest = (challengeId: Hex, signature: Hex) =>
    post(app(), '/api/reviews/attest', { challengeId, signature });

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
    now = START;
    rpSigner = makeRpSigner();
  });

  afterEach(() => {
    db.close();
  });

  it('re-issues a fresh attestation after the deadline and a cutover', async () => {
    // 1-3. The user completes the flow and gets an attestation.
    const { prepare, signature } = await prepareAndSign();

    const firstRes = await attest(prepare.challenge_id, signature);
    expect(firstRes.status).toBe(200);
    const first = (await firstRes.json()) as AttestBody;
    const firstExpiry = Number(first.attestation['expiry']);
    expect(firstExpiry).toBe(START + DEFAULT_ATTESTATION_TTL_SECONDS);

    // 4. The challenge deadline passes.
    now = prepare.deadline + 1;
    expect(now).toBeGreaterThan(prepare.deadline);

    // 5. A cutover: the attestation the user holds is now worthless, because a
    //    replacement gateway verifies a different digest. Nothing server-side
    //    changes — which is the point. The user still holds only the challenge
    //    id and the signature they already made.
    now = prepare.deadline + 7_200;

    // 6. The identical pair, re-posted.
    const secondRes = await attest(prepare.challenge_id, signature);
    expect(secondRes.status).toBe(200);
    const second = (await secondRes.json()) as AttestBody;

    // 7-8. A fresh attestation, with a full one-hour lifetime from now.
    const secondExpiry = Number(second.attestation['expiry']);
    expect(secondExpiry).toBe(now + DEFAULT_ATTESTATION_TTL_SECONDS);
    expect(secondExpiry).toBeGreaterThan(firstExpiry);
    expect(second.attestation.signature).not.toBe(first.attestation.signature);

    // Everything else is identical: the retry re-signs the same review, it does
    // not mint a different one.
    const { signature: _s1, expiry: _e1, ...firstFields } = first.attestation;
    const { signature: _s2, expiry: _e2, ...secondFields } = second.attestation;
    expect(secondFields).toEqual(firstFields);
  });

  it('would leave the holder with no other route to an attestation', async () => {
    // Why the replay matters: starting over is not available. The challenge is
    // consumed and the verification authorized, so a fresh /prepare for the
    // same human and agent is refused.
    const { prepare, signature } = await prepareAndSign();
    expect((await attest(prepare.challenge_id, signature)).status).toBe(200);

    const instance = app();
    const request = (await (
      await post(instance, '/api/world-id/request', { agentId: AGENT_ID })
    ).json()) as RequestBody;
    const verifyRes = await post(instance, '/api/reviews/verify', {
      agentId: AGENT_ID,
      reviewer: REVIEWER,
      proof: proofFor(request.rp_context.nonce, request.action, REVIEWER),
    });

    // The same human cannot even re-verify for this agent.
    expect(verifyRes.status).not.toBe(200);
  });

  /** The high-s twin: same curve point, different bytes, same recovered signer. */
  function malleate(signature: Hex): Hex {
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const r = signature.slice(2, 66);
    const sv = BigInt(`0x${signature.slice(66, 130)}`);
    const v = Number.parseInt(signature.slice(130, 132), 16);
    const high = (n - sv).toString(16).padStart(64, '0');
    const flipped = (v === 27 ? 28 : 27).toString(16).padStart(2, '0');
    return `0x${r}${high}${flipped}`;
  }

  it('refuses a signature from another wallet outright', async () => {
    const { prepare, signature } = await prepareAndSign();
    expect((await attest(prepare.challenge_id, signature)).status).toBe(200);

    now = prepare.deadline + 7_200;

    // Signed by someone else over the same typed data.
    const other = await privateKeyToAccount(OTHER_KEY).signTypedData({
      domain: prepare.typed_data.domain,
      types: prepare.typed_data.types,
      primaryType: prepare.typed_data.primaryType,
      message: prepare.typed_data.message,
    } as never);
    expect(other).not.toBe(signature);

    // Rejected before the challenge is even reached: it is not the reviewer's.
    const res = await attest(prepare.challenge_id, other);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_wallet_signature' });

    // The stored signature is untouched by the rejected attempt.
    expect(findReviewAuthorization(db, prepare.challenge_id)?.signature?.toLowerCase()).toBe(
      signature.toLowerCase(),
    );
  });

  it('treats a different-but-valid signature on a spent challenge as a conflict', async () => {
    // The case the replay rule has to distinguish: bytes that differ yet still
    // recover to the reviewer. Only an identical signature is a retry.
    const { prepare, signature } = await prepareAndSign();
    expect((await attest(prepare.challenge_id, signature)).status).toBe(200);

    now = prepare.deadline + 7_200;

    const twin = malleate(signature);
    expect(twin).not.toBe(signature);
    expect(twin.slice(2, 66)).toBe(signature.slice(2, 66)); // same r

    const res = await attest(prepare.challenge_id, twin);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'signature_conflict' });

    // The stored signature is untouched by the rejected attempt.
    expect(findReviewAuthorization(db, prepare.challenge_id)?.signature?.toLowerCase()).toBe(
      signature.toLowerCase(),
    );
  });

  it('refuses the signature against a different challenge', async () => {
    const first = await prepareAndSign();
    expect((await attest(first.prepare.challenge_id, first.signature)).status).toBe(200);

    // A second challenge, for a different agent, so a second verification is
    // allowed. The first challenge's signature must not satisfy it.
    const second = await prepareAndSign(SECOND_AGENT_ID, NULLIFIER_DECIMAL);
    expect(second.prepare.challenge_id).not.toBe(first.prepare.challenge_id);

    const res = await attest(second.prepare.challenge_id, first.signature);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_wallet_signature' });

    // The second challenge is left unspent, so its holder can still use it.
    expect(findReviewAuthorization(db, second.prepare.challenge_id)?.consumedAt).toBeNull();
  });

  it('keeps one-human-one-review intact across the replay', async () => {
    const { prepare, signature } = await prepareAndSign();

    await attest(prepare.challenge_id, signature);
    now = prepare.deadline + 7_200;
    await attest(prepare.challenge_id, signature);

    // Replaying mints a second attestation but spends nothing extra: one
    // consumed challenge, one authorized verification. The on-chain nullifier
    // guard still permits only one of them to land.
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM review_authorizations WHERE consumed_at IS NOT NULL')
        .get(),
    ).toEqual({ n: 1 });
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM world_id_verifications WHERE authorized_at IS NOT NULL')
        .get(),
    ).toEqual({ n: 1 });

    // And the consumption timestamp is the original, not the retry's.
    expect(findReviewAuthorization(db, prepare.challenge_id)?.consumedAt).toBe(START);
  });

  it('replays indefinitely, so the window to migrate is not time-boxed', async () => {
    const { prepare, signature } = await prepareAndSign();
    const first = (await (await attest(prepare.challenge_id, signature)).json()) as AttestBody;

    now = prepare.deadline + 30 * 86_400;

    const late = await attest(prepare.challenge_id, signature);
    expect(late.status).toBe(200);
    const body = (await late.json()) as AttestBody;
    expect(Number(body.attestation['expiry'])).toBe(now + DEFAULT_ATTESTATION_TTL_SECONDS);
    expect(body.attestation.signature).not.toBe(first.attestation.signature);
  });
});

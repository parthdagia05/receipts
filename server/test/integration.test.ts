import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { getAddress, keccak256, toBytes } from 'viem';
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { createApp } from '../src/app.js';
import { IN_MEMORY, openDatabase } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { findReviewAuthorization } from '../src/db/reviewAuthorizations.js';
import { REVIEW_TYPE, ZERO_BYTES32 } from '../src/signing/reviewContent.js';
import { feedbackUriFor } from '../src/signing/feedbackUri.js';
import type { VerifyOutcome, WorldIdVerifier } from '../src/worldid/verifyClient.js';
import type { RpContextSigner } from '../src/worldid/signing.js';
import { VALID_ENV, appDeps, testAttestationSigner } from './fixtures.js';

/**
 * The whole review flow, over HTTP, with each response feeding the next
 * request.
 *
 * Nothing is hand-seeded: every row exists because an endpoint created it. The
 * only substitution is the World ID Developer Portal, which is an external
 * service — the routes, database, authorization logic, signing code and wallet
 * verification are all the real ones.
 *
 * What the per-route suites cannot show is whether two correct modules agree.
 * This one can, because the wallet signs the `typed_data` the server actually
 * served, byte for byte, rather than a locally rebuilt copy.
 */

/** 2^53 + 1: survives only if nothing in the chain routes it through a double. */
const AGENT_ID = '9007199254740993';

/** Wide enough that the decimal → bytes32 conversion is not incidental. */
const NULLIFIER_DECIMAL = '98765432109876543210987654321098765432109876543210';

const REVIEWER_KEY: Hex = `0x${'7a'.repeat(32)}`;
const REVIEWER = privateKeyToAddress(REVIEWER_KEY);

const CONTENT = 'Settled the refund without being asked twice. Would hire again.';
const VALUE = 73;
const NOW = 1_793_740_600;
const ATTESTATION_TTL = 3_600;

const CHAIN_ID = Number(VALID_ENV.CHAIN_ID);
const GATEWAY = getAddress(VALID_ENV.REVIEW_GATEWAY_ADDRESS);

/** The `typed_data` block as it arrives over the wire. */
interface WireTypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

interface RequestBody {
  app_id: string;
  action: string;
  rp_context: {
    rp_id: string;
    nonce: string;
    created_at: number;
    expires_at: number;
    signature: string;
  };
}

interface VerifyBody {
  agent_id: string;
  reviewer: Address;
  nullifier: string;
  verified_at: number;
}

interface PrepareBody {
  challenge_id: Hex;
  deadline: number;
  feedback_hash: Hex;
  typed_data: WireTypedData;
}

interface AttestBody {
  attestation: Record<string, unknown> & { signature: Hex };
  gateway: Address;
  submit_function: string;
  submitted: boolean;
}

describe('the review flow end to end', () => {
  let db: Db;
  /** Every IDKit result the server forwarded to the Portal. */
  let forwarded: Record<string, unknown>[];

  /**
   * Stands in for the Developer Portal.
   *
   * Echoes the action the server forwarded rather than a literal, so the action
   * derived in step 1 and re-derived in step 2 must genuinely agree.
   */
  function portal(nullifier = NULLIFIER_DECIMAL): WorldIdVerifier {
    return async (result) => {
      forwarded.push(result as unknown as Record<string, unknown>);
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

  /**
   * An RP signer that issues a distinct nonce per call.
   *
   * The shared `fakeRpContextSigner` returns one fixed nonce, which is fine for
   * single-request tests but collides on the second issue here — the real
   * `signRequest` draws fresh randomness every call, so this mirrors it with a
   * counter instead.
   */
  function makeRpSigner(): RpContextSigner {
    let issued = 0;
    return () => {
      issued += 1;
      return {
        rp_id: VALID_ENV.WORLD_RP_ID,
        nonce: `0x${issued.toString(16).padStart(4, '0').repeat(16)}`,
        created_at: NOW - 60,
        expires_at: NOW + 240,
        signature: `0x${'cd'.repeat(65)}`,
      };
    };
  }

  /** Shared for the whole test, so two flows cannot be issued one nonce. */
  let rpSigner: RpContextSigner;

  function app(verifier: WorldIdVerifier = portal()) {
    return createApp(
      appDeps(db, { now: () => NOW, worldIdVerifier: verifier, rpContextSigner: rpSigner }),
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

  /** An IDKit v4 result answering `nonce` for `action`, bound to `reviewer`. */
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
          expires_at_min: NOW + 86_400,
          // The official helper, as the frontend would use it.
          signal_hash: hashSignal(reviewer),
        },
      ],
    };
  }

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
    forwarded = [];
    rpSigner = makeRpSigner();
  });

  afterEach(() => {
    db.close();
  });

  /**
   * Walk the whole flow and return every step's response.
   *
   * The wallet signature is taken over the served `typed_data` exactly as
   * received — domain, types, primaryType and message, unmodified. viem accepts
   * the decimal-string integers the wire form carries, so nothing is rebuilt
   * and nothing is re-encoded.
   */
  async function runFlow(
    options: { reviewer?: Address; signerKey?: Hex; agentId?: string } = {},
  ): Promise<{
    request: RequestBody;
    verify: VerifyBody;
    prepare: PrepareBody;
    attest: AttestBody;
    attestStatus: number;
    signature: Hex;
  }> {
    const reviewer = options.reviewer ?? REVIEWER;
    const agentId = options.agentId ?? AGENT_ID;
    const instance = app();

    // 1. Ask for a World ID request.
    const requestRes = await post(instance, '/api/world-id/request', { agentId });
    expect(requestRes.status).toBe(200);
    const request = (await requestRes.json()) as RequestBody;

    // 2. Submit the proof, carrying the issued nonce and action verbatim.
    const verifyRes = await post(instance, '/api/reviews/verify', {
      agentId,
      reviewer,
      proof: proofFor(request.rp_context.nonce, request.action, reviewer),
    });
    expect(verifyRes.status).toBe(200);
    const verify = (await verifyRes.json()) as VerifyBody;

    // 3. Prepare the review, naming the exact request that was completed.
    const prepareRes = await post(instance, '/api/reviews/prepare', {
      agentId,
      reviewer,
      requestNonce: request.rp_context.nonce,
      value: VALUE,
      valueDecimals: 0,
      reviewType: REVIEW_TYPE.FREE,
      content: CONTENT,
    });
    expect(prepareRes.status).toBe(200);
    const prepare = (await prepareRes.json()) as PrepareBody;

    // 4. The wallet signs what it was served. Nothing is reconstructed here —
    //    rebuilding the message locally is exactly the blind spot this test
    //    exists to close.
    const signature = await privateKeyToAccount(options.signerKey ?? REVIEWER_KEY).signTypedData({
      domain: prepare.typed_data.domain,
      types: prepare.typed_data.types,
      primaryType: prepare.typed_data.primaryType,
      message: prepare.typed_data.message,
    } as never);

    // 5. Exchange the signature for a gateway attestation.
    const attestRes = await post(instance, '/api/reviews/attest', {
      challengeId: prepare.challenge_id,
      signature,
    });
    const attest = (await attestRes.json()) as AttestBody;

    return { request, verify, prepare, attest, attestStatus: attestRes.status, signature };
  }

  describe('the happy path', () => {
    it('carries one review from World ID request to signed attestation', async () => {
      const { attestStatus, attest } = await runFlow();

      expect(attestStatus).toBe(200);
      expect(attest.submit_function).toBe('submitFreeReview');
      expect(attest.gateway).toBe(GATEWAY);
    });

    it('produces an attestation the gateway would accept', async () => {
      const { attest, prepare } = await runFlow();

      // Recovers to the configured Record Server signer over the ten fields.
      const signer = testAttestationSigner();
      const verified = await signer.verify(
        {
          agentId: BigInt(AGENT_ID),
          nullifier: attest.attestation['nullifier'] as Hex,
          reviewer: REVIEWER,
          expiry: BigInt(NOW + ATTESTATION_TTL),
          value: BigInt(VALUE),
          valueDecimals: 0,
          feedbackHash: prepare.feedback_hash,
          feedbackURI: feedbackUriFor(VALID_ENV.REVIEW_CONTENT_BASE_URL, prepare.feedback_hash),
          reviewType: REVIEW_TYPE.FREE,
          receiptId: ZERO_BYTES32,
        },
        attest.attestation.signature,
      );

      expect(verified).toBe(true);
      expect(signer.address).toBe(privateKeyToAddress(VALID_ENV.RECORD_SERVER_PRIVATE_KEY));
    });

    it('returns the exact review fields', async () => {
      const { attest, prepare } = await runFlow();
      const { signature: _sig, ...fields } = attest.attestation;

      expect(fields).toEqual({
        agentId: AGENT_ID,
        nullifier: attest.attestation['nullifier'],
        reviewer: REVIEWER,
        expiry: String(NOW + ATTESTATION_TTL),
        value: String(VALUE),
        valueDecimals: 0,
        feedbackHash: prepare.feedback_hash,
        feedbackURI: feedbackUriFor(VALID_ENV.REVIEW_CONTENT_BASE_URL, prepare.feedback_hash),
        reviewType: REVIEW_TYPE.FREE,
        receiptId: ZERO_BYTES32,
      });
    });

    it('publishes a feedbackURI that resolves to the content that was reviewed', async () => {
      // The end of the F-01 fix: the URI the gateway will publish is signed,
      // and what it points at is the text this flow actually hashed.
      //
      // Fetched from `createApp` — the same assembly `server.ts` serves — not
      // from a separately mounted copy of the route. A retrieval route that
      // worked in isolation but was never wired into the app would publish
      // URIs that 404 in production, and nothing else here would notice.
      const { attest, prepare } = await runFlow();
      const uri = attest.attestation['feedbackURI'] as string;

      expect(uri).toBe(feedbackUriFor(VALID_ENV.REVIEW_CONTENT_BASE_URL, prepare.feedback_hash));

      const production = app();
      const res = await production.request(new URL(uri).pathname);
      expect(res.status).toBe(200);

      const served = new Uint8Array(await res.arrayBuffer());
      expect(new TextDecoder().decode(served)).toBe(CONTENT);
      expect(keccak256(served)).toBe(prepare.feedback_hash);
    });

    it('answers an unreviewed hash through the same app with a 404', async () => {
      // Only that a miss is a clean 404 over the production app. It cannot tell
      // a mounted route's miss from the app's catch-all — both answer
      // `{error:'not_found'}` — so the test above is what proves the route is
      // wired in; verified by unmounting it, which fails that test and not this
      // one.
      await runFlow();

      const absent = keccak256(toBytes('nobody reviewed this'));
      const res = await app().request(
        new URL(feedbackUriFor(VALID_ENV.REVIEW_CONTENT_BASE_URL, absent)).pathname,
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    });

    it('does not claim the review reached the chain', async () => {
      const { attest } = await runFlow();

      expect(attest.submitted).toBe(false);
    });
  });

  describe('state after the flow', () => {
    it('consumes the challenge exactly once', async () => {
      const { prepare } = await runFlow();

      expect(findReviewAuthorization(db, prepare.challenge_id)?.consumedAt).toBe(NOW);
      expect(
        db
          .prepare('SELECT COUNT(*) AS n FROM review_authorizations WHERE consumed_at IS NOT NULL')
          .get(),
      ).toEqual({ n: 1 });
    });

    it('authorizes the World ID verification exactly once', async () => {
      await runFlow();

      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM world_id_verifications WHERE authorized_at IS NOT NULL',
          )
          .get(),
      ).toEqual({ n: 1 });
    });

    it('consumes the RP request', async () => {
      const { request } = await runFlow();

      const row = db
        .prepare('SELECT consumed_at FROM world_id_requests WHERE nonce = ?')
        .get(request.rp_context.nonce) as { consumed_at: number | null };

      expect(row.consumed_at).not.toBeNull();
    });

    it('refuses a second review from the same verification', async () => {
      const { request } = await runFlow();
      const instance = app();

      // The proof is spent and the verification authorized; a fresh challenge
      // for it must be refused.
      const res = await post(instance, '/api/reviews/prepare', {
        agentId: AGENT_ID,
        reviewer: REVIEWER,
        requestNonce: request.rp_context.nonce,
        value: 10,
        valueDecimals: 0,
        reviewType: REVIEW_TYPE.FREE,
        content: 'Changed my mind.',
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'verification_already_authorized' });
    });
  });

  describe('values agree across every seam', () => {
    it('uses one derived action from request through verification', async () => {
      const { request } = await runFlow();

      // Derived in step 1, carried in the proof, re-derived and compared in
      // step 2 — and the Portal saw the same string.
      expect(request.action).toBe(`review-agent-${AGENT_ID}`);
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]?.['action']).toBe(request.action);
    });

    it('carries the issued RP nonce through the whole chain', async () => {
      const { request, prepare } = await runFlow();
      const issued = request.rp_context.nonce;

      expect(forwarded[0]?.['nonce']).toBe(issued);
      expect(findReviewAuthorization(db, prepare.challenge_id)?.verificationNonce).toBe(issued);
    });

    it('turns the API nullifier into the bytes32 the attestation carries', async () => {
      const { verify, prepare, attest } = await runFlow();

      // The decimal the Portal returned, unchanged through /verify.
      expect(verify.nullifier).toBe(NULLIFIER_DECIMAL);

      // The same value, left-padded to 32 bytes, in both the signed
      // authorization and the attestation.
      const expected = `0x${BigInt(NULLIFIER_DECIMAL).toString(16).padStart(64, '0')}`;
      expect(prepare.typed_data.message['nullifier']).toBe(expected);
      expect(attest.attestation['nullifier']).toBe(expected);
      expect(BigInt(attest.attestation['nullifier'] as Hex).toString(10)).toBe(NULLIFIER_DECIMAL);
    });

    it('hashes the submitted content into the attestation', async () => {
      const { prepare, attest } = await runFlow();

      expect(prepare.feedback_hash).toBe(keccak256(toBytes(CONTENT)));
      expect(prepare.typed_data.message['feedbackHash']).toBe(prepare.feedback_hash);
      expect(attest.attestation['feedbackHash']).toBe(prepare.feedback_hash);
    });

    it('preserves an agent id beyond double precision', async () => {
      const { request, prepare, attest } = await runFlow();

      // 2^53 + 1 would come back as ...992 if anything parsed it as a number.
      expect(request.action.endsWith(AGENT_ID)).toBe(true);
      expect(prepare.typed_data.message['agentId']).toBe(AGENT_ID);
      expect(attest.attestation['agentId']).toBe(AGENT_ID);
    });

    it('serves the configured chain and gateway to the wallet', async () => {
      const { prepare } = await runFlow();

      expect(prepare.typed_data.domain).toEqual({
        name: 'ReceiptsReviewAuthorization',
        version: '1',
        chainId: CHAIN_ID,
        verifyingContract: GATEWAY,
      });
    });

    it('signs the deadline the challenge was stored with', async () => {
      const { prepare } = await runFlow();

      expect(prepare.typed_data.message['deadline']).toBe(String(prepare.deadline));
      expect(findReviewAuthorization(db, prepare.challenge_id)?.deadline).toBe(prepare.deadline);
    });

    it('signs the challenge id the attest step consumes', async () => {
      const { prepare } = await runFlow();

      expect(prepare.typed_data.message['nonce']).toBe(prepare.challenge_id);
    });
  });

  describe('the served message is what the server verifies', () => {
    it('rejects a signature over a message altered after it was served', async () => {
      // Signing anything other than the served document must fail, which is
      // what proves /attest verifies against the stored challenge and not
      // against whatever the caller presents.
      const instance = app();
      const request = (await (
        await post(instance, '/api/world-id/request', { agentId: AGENT_ID })
      ).json()) as RequestBody;
      await post(instance, '/api/reviews/verify', {
        agentId: AGENT_ID,
        reviewer: REVIEWER,
        proof: proofFor(request.rp_context.nonce, request.action, REVIEWER),
      });
      const prepare = (await (
        await post(instance, '/api/reviews/prepare', {
          agentId: AGENT_ID,
          reviewer: REVIEWER,
          requestNonce: request.rp_context.nonce,
          value: VALUE,
          valueDecimals: 0,
          reviewType: REVIEW_TYPE.FREE,
          content: CONTENT,
        })
      ).json()) as PrepareBody;

      // One field changed, everything else as served.
      const tampered = { ...prepare.typed_data.message, value: String(VALUE + 1) };
      const signature = await privateKeyToAccount(REVIEWER_KEY).signTypedData({
        domain: prepare.typed_data.domain,
        types: prepare.typed_data.types,
        primaryType: prepare.typed_data.primaryType,
        message: tampered,
      } as never);

      const res = await post(instance, '/api/reviews/attest', {
        challengeId: prepare.challenge_id,
        signature,
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_wallet_signature' });
      expect(findReviewAuthorization(db, prepare.challenge_id)?.consumedAt).toBeNull();
    });

    it('rejects a signature from a wallet other than the reviewer', async () => {
      const { attestStatus, attest, prepare } = await runFlow({
        signerKey: `0x${'5b'.repeat(32)}`,
      });

      expect(attestStatus).toBe(400);
      expect(attest).toMatchObject({ error: 'invalid_wallet_signature' });
      expect(findReviewAuthorization(db, prepare.challenge_id)?.consumedAt).toBeNull();
    });
  });

  describe('two agents stay independent', () => {
    it('gives each agent its own action and attestation', async () => {
      const second = '77';
      const first = await runFlow();
      const other = await runFlow({ agentId: second });

      expect(first.request.action).toBe(`review-agent-${AGENT_ID}`);
      expect(other.request.action).toBe(`review-agent-${second}`);
      expect(other.attestStatus).toBe(200);
      expect(other.attest.attestation['agentId']).toBe(second);

      // The same human reviewing two agents: both authorized, independently.
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM world_id_verifications WHERE authorized_at IS NOT NULL',
          )
          .get(),
      ).toEqual({ n: 2 });
    });
  });
});

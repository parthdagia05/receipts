import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAddress, hashTypedData, keccak256, toBytes } from 'viem';
import type { Address, Hex } from 'viem';
import { createApp } from '../src/app.js';
import { IN_MEMORY, openDatabase } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { recordWorldIdRequest } from '../src/db/worldIdRequests.js';
import { consumeAndRecordVerification } from '../src/db/worldIdVerifications.js';
import {
  consumeReviewAuthorization,
  findReviewAuthorization,
} from '../src/db/reviewAuthorizations.js';
import {
  AUTHORIZATION_PRIMARY_TYPE,
  AUTHORIZATION_TYPES,
  authorizationDomain,
} from '../src/signing/reviewAuthorization.js';
import { REVIEW_TYPE, ZERO_BYTES32, nullifierToBytes32 } from '../src/signing/reviewContent.js';
import { MAX_CONTENT_BYTES } from '../src/routes/reviewPrepare.js';
import { VALID_ENV, appDeps } from './fixtures.js';

const ENDPOINT = '/api/reviews/prepare';
const NOW = 1_793_740_600;
const TTL = 300;
const RP_NONCE = `0x${'ab'.repeat(32)}`;
const REVIEWER = getAddress(`0x${'ab'.repeat(20)}`);
const NULLIFIER_DECIMAL = '7';
const CONTENT = 'The agent answered precisely and refunded the overcharge.';
const CHAIN_ID = Number(VALID_ENV.CHAIN_ID);
const GATEWAY = getAddress(VALID_ENV.REVIEW_GATEWAY_ADDRESS);

interface PrepareBody {
  readonly challenge_id: Hex;
  readonly deadline: number;
  readonly feedback_hash: Hex;
  readonly typed_data: {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  };
}

describe('POST /api/reviews/prepare', () => {
  let db: Db;

  /** A verified World ID proof for `agentId` by `reviewer`. */
  function seedVerification(
    overrides: {
      nonce?: string;
      agentId?: string;
      reviewer?: Address;
      nullifier?: string;
      verifiedAt?: number;
    } = {},
  ): string {
    const nonce = overrides.nonce ?? RP_NONCE;
    const agentId = overrides.agentId ?? '42';
    const action = `review-agent-${agentId}`;

    recordWorldIdRequest(db, {
      nonce,
      rpId: VALID_ENV.WORLD_RP_ID,
      action,
      agentId,
      createdAt: NOW - 200,
      expiresAt: NOW + 1000,
    });
    const recorded = consumeAndRecordVerification(db, {
      nonce,
      rpId: VALID_ENV.WORLD_RP_ID,
      action,
      agentId,
      reviewer: overrides.reviewer ?? REVIEWER,
      nullifier: overrides.nullifier ?? NULLIFIER_DECIMAL,
      now: overrides.verifiedAt ?? NOW - 100,
    });
    expect(recorded.ok).toBe(true);
    return nonce;
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

  /** A valid free-review submission naming the seeded World ID request. */
  function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      agentId: '42',
      reviewer: REVIEWER,
      requestNonce: RP_NONCE,
      value: 80,
      valueDecimals: 0,
      reviewType: REVIEW_TYPE.FREE,
      content: CONTENT,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('valid preparation', () => {
    it('returns typed data, a challenge id and a deadline for a free review', async () => {
      seedVerification();
      const app = buildApp();

      const res = await post(app, submission());
      expect(res.status).toBe(200);

      const body = (await res.json()) as PrepareBody;
      expect(body.challenge_id).toMatch(/^0x[0-9a-f]{64}$/);
      expect(body.deadline).toBe(NOW + TTL);
      expect(body.feedback_hash).toBe(keccak256(toBytes(CONTENT)));
      expect(body.typed_data.primaryType).toBe(AUTHORIZATION_PRIMARY_TYPE);
    });

    it('prepares a paid review with a receipt', async () => {
      seedVerification();
      const receiptId = `0x${'77'.repeat(32)}`;
      const app = buildApp();

      const res = await post(
        app,
        submission({ reviewType: REVIEW_TYPE.PAID, receiptId, value: 95 }),
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as PrepareBody;
      expect(body.typed_data.message['reviewType']).toBe(REVIEW_TYPE.PAID);
      expect(body.typed_data.message['receiptId']).toBe(receiptId);
      expect(body.typed_data.message['value']).toBe('95');
    });

    it('defaults receiptId to zero on the free path', async () => {
      seedVerification();
      const body = (await (await post(buildApp(), submission())).json()) as PrepareBody;

      expect(body.typed_data.message['receiptId']).toBe(ZERO_BYTES32);
    });

    it('accepts a lowercase reviewer and binds the checksummed form', async () => {
      seedVerification();

      const body = (await (
        await post(buildApp(), submission({ reviewer: REVIEWER.toLowerCase() }))
      ).json()) as PrepareBody;

      expect(body.typed_data.message['reviewer']).toBe(REVIEWER);
    });
  });

  describe('typed data bindings', () => {
    it('binds every review field, including the server-derived ones', async () => {
      seedVerification();
      const body = (await (await post(buildApp(), submission())).json()) as PrepareBody;

      expect(body.typed_data.message).toEqual({
        agentId: '42',
        // From the stored verification, converted once — never from the client.
        nullifier: nullifierToBytes32(NULLIFIER_DECIMAL),
        reviewer: REVIEWER,
        value: '80',
        valueDecimals: 0,
        feedbackHash: keccak256(toBytes(CONTENT)),
        reviewType: REVIEW_TYPE.FREE,
        receiptId: ZERO_BYTES32,
        nonce: body.challenge_id,
        deadline: String(NOW + TTL),
      });
    });

    it('uses the configured chain and gateway in the domain', async () => {
      seedVerification();
      const body = (await (await post(buildApp(), submission())).json()) as PrepareBody;

      expect(body.typed_data.domain).toEqual({
        name: 'ReceiptsReviewAuthorization',
        version: '1',
        chainId: CHAIN_ID,
        verifyingContract: GATEWAY,
      });
    });

    it('declares all ten fields in the documented order', async () => {
      seedVerification();
      const body = (await (await post(buildApp(), submission())).json()) as PrepareBody;

      expect(body.typed_data.types['ReviewAuthorization']?.map((f) => f.name)).toEqual(
        AUTHORIZATION_TYPES.ReviewAuthorization.map((f) => f.name),
      );
    });

    it('is signable: the serialized data hashes to the same digest', async () => {
      // Integers are rendered as decimal strings for JSON; the digest must be
      // unchanged, or the wallet would sign something the server cannot verify.
      seedVerification();
      const body = (await (await post(buildApp(), submission())).json()) as PrepareBody;

      const fromWire = hashTypedData({
        domain: body.typed_data.domain,
        types: body.typed_data.types,
        primaryType: body.typed_data.primaryType,
        message: body.typed_data.message,
      } as never);

      const fromValues = hashTypedData({
        domain: authorizationDomain(CHAIN_ID, GATEWAY),
        types: AUTHORIZATION_TYPES,
        primaryType: AUTHORIZATION_PRIMARY_TYPE,
        message: {
          agentId: 42n,
          nullifier: nullifierToBytes32(NULLIFIER_DECIMAL),
          reviewer: REVIEWER,
          value: 80n,
          valueDecimals: 0,
          feedbackHash: keccak256(toBytes(CONTENT)),
          reviewType: REVIEW_TYPE.FREE,
          receiptId: ZERO_BYTES32,
          nonce: body.challenge_id,
          deadline: BigInt(NOW + TTL),
        },
      });

      expect(fromWire).toBe(fromValues);
    });

    it('changes the digest when the content changes', async () => {
      seedVerification();
      const first = (await (await post(buildApp(), submission())).json()) as PrepareBody;
      const second = (await (
        await post(buildApp(), submission({ content: 'A different review entirely.' }))
      ).json()) as PrepareBody;

      expect(first.feedback_hash).not.toBe(second.feedback_hash);
      expect(first.typed_data.message['feedbackHash']).not.toBe(
        second.typed_data.message['feedbackHash'],
      );
    });
  });

  describe('challenge persistence', () => {
    it('stores the challenge bound to the verification', async () => {
      const nonce = seedVerification();
      const body = (await (await post(buildApp(), submission())).json()) as PrepareBody;

      expect(findReviewAuthorization(db, body.challenge_id)).toMatchObject({
        verificationNonce: nonce,
        agentId: '42',
        reviewer: REVIEWER,
        nullifier: nullifierToBytes32(NULLIFIER_DECIMAL),
        value: 80,
        valueDecimals: 0,
        feedbackHash: keccak256(toBytes(CONTENT)),
        reviewType: REVIEW_TYPE.FREE,
        receiptId: ZERO_BYTES32,
        deadline: NOW + TTL,
        consumedAt: null,
        signature: null,
      });
    });

    it('does not consume the challenge', async () => {
      seedVerification();
      const body = (await (await post(buildApp(), submission())).json()) as PrepareBody;

      expect(findReviewAuthorization(db, body.challenge_id)?.consumedAt).toBeNull();
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM world_id_verifications WHERE authorized_at IS NOT NULL',
          )
          .get(),
      ).toEqual({ n: 0 });
    });

    it('issues a distinct challenge each time', async () => {
      seedVerification();
      const app = buildApp();

      const first = (await (await post(app, submission())).json()) as PrepareBody;
      const second = (await (await post(app, submission({ value: 90 }))).json()) as PrepareBody;

      expect(first.challenge_id).not.toBe(second.challenge_id);
      expect(db.prepare('SELECT COUNT(*) AS n FROM review_authorizations').get()).toEqual({ n: 2 });
    });
  });

  describe('repeated preparation', () => {
    it('allows redrafting while the verification is unauthorized', async () => {
      seedVerification();
      const app = buildApp();

      expect((await post(app, submission({ value: 10 }))).status).toBe(200);
      expect((await post(app, submission({ value: 90 }))).status).toBe(200);
    });

    it('refuses once a challenge has been consumed', async () => {
      seedVerification();
      const app = buildApp();
      const body = (await (await post(app, submission())).json()) as PrepareBody;

      expect(
        consumeReviewAuthorization(db, {
          nonce: body.challenge_id,
          signature: `0x${'cd'.repeat(65)}`,
          now: NOW + 1,
        }).ok,
      ).toBe(true);

      const again = await post(app, submission());
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: 'verification_already_authorized' });
    });

    it('writes no challenge once the verification is authorized', async () => {
      seedVerification();
      const app = buildApp();
      const body = (await (await post(app, submission())).json()) as PrepareBody;
      consumeReviewAuthorization(db, {
        nonce: body.challenge_id,
        signature: `0x${'cd'.repeat(65)}`,
        now: NOW + 1,
      });

      await post(app, submission());

      expect(db.prepare('SELECT COUNT(*) AS n FROM review_authorizations').get()).toEqual({ n: 1 });
    });
  });

  describe('verification binding', () => {
    it('returns 404 when no verification exists', async () => {
      const res = await post(buildApp(), submission());

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'unknown_verification' });
    });

    it('selects the verification named by the request nonce', async () => {
      seedVerification({ nonce: RP_NONCE, nullifier: '111' });
      const other = `0x${'22'.repeat(32)}`;
      seedVerification({ nonce: other, nullifier: '222', verifiedAt: NOW - 10 });

      const body = (await (
        await post(buildApp(), submission({ requestNonce: other }))
      ).json()) as PrepareBody;

      expect(body.typed_data.message['nullifier']).toBe(nullifierToBytes32('222'));
      expect(findReviewAuthorization(db, body.challenge_id)?.verificationNonce).toBe(other);
    });

    it('rejects an unknown request nonce', async () => {
      seedVerification();

      const res = await post(buildApp(), submission({ requestNonce: `0x${'ee'.repeat(32)}` }));

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'unknown_verification' });
    });

    it.each(['', '0xbeef', 'not-hex', `0x${'ab'.repeat(31)}`])(
      'rejects the malformed request nonce %o',
      async (requestNonce) => {
        seedVerification();

        const res = await post(buildApp(), submission({ requestNonce }));

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'invalid_request_nonce' });
      },
    );

    it('rejects a missing request nonce', async () => {
      seedVerification();

      const res = await post(buildApp(), submission({ requestNonce: undefined }));

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_request_nonce' });
    });

    it('rejects a nonce whose verification is for another agent', async () => {
      // The nonce is real, but it proves personhood for a different agent.
      const other = `0x${'33'.repeat(32)}`;
      seedVerification({ nonce: other, agentId: '99', nullifier: '999' });

      const res = await post(buildApp(), submission({ requestNonce: other }));

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'verification_agent_mismatch' });
    });

    it('rejects a nonce whose verification is for another reviewer', async () => {
      const other = `0x${'44'.repeat(32)}`;
      seedVerification({
        nonce: other,
        reviewer: getAddress(`0x${'cd'.repeat(20)}`),
        nullifier: '444',
      });

      const res = await post(buildApp(), submission({ requestNonce: other }));

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'verification_reviewer_mismatch' });
    });

    it('cannot be made to pick the wrong proof when a wallet holds two', async () => {
      // Two humans, one wallet, one agent. Each nonce must select its own
      // proof — never the other's, and never whichever happens to be newest.
      const first = `0x${'55'.repeat(32)}`;
      const second = `0x${'66'.repeat(32)}`;
      seedVerification({ nonce: first, nullifier: '111', verifiedAt: NOW - 100 });
      seedVerification({ nonce: second, nullifier: '222', verifiedAt: NOW - 10 });

      const app = buildApp();
      const a = (await (
        await post(app, submission({ requestNonce: first }))
      ).json()) as PrepareBody;
      const b = (await (
        await post(app, submission({ requestNonce: second }))
      ).json()) as PrepareBody;

      expect(a.typed_data.message['nullifier']).toBe(nullifierToBytes32('111'));
      expect(b.typed_data.message['nullifier']).toBe(nullifierToBytes32('222'));
      expect(findReviewAuthorization(db, a.challenge_id)?.verificationNonce).toBe(first);
      expect(findReviewAuthorization(db, b.challenge_id)?.verificationNonce).toBe(second);
    });

    it('rejects a verification that is already authorized', async () => {
      seedVerification();
      const app = buildApp();
      const body = (await (await post(app, submission())).json()) as PrepareBody;
      consumeReviewAuthorization(db, {
        nonce: body.challenge_id,
        signature: `0x${'cd'.repeat(65)}`,
        now: NOW + 1,
      });

      const res = await post(app, submission());

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'verification_already_authorized' });
    });

    it.each([
      ['an unknown nonce', { requestNonce: `0x${'ee'.repeat(32)}` }],
      ['a malformed nonce', { requestNonce: '0xbeef' }],
    ])('persists no challenge for %s', async (_label, overrides) => {
      seedVerification();

      await post(buildApp(), submission(overrides));

      expect(db.prepare('SELECT COUNT(*) AS n FROM review_authorizations').get()).toEqual({ n: 0 });
    });

    it('persists no challenge on an agent or reviewer mismatch', async () => {
      const other = `0x${'77'.repeat(32)}`;
      seedVerification({ nonce: other, agentId: '99', nullifier: '999' });

      await post(buildApp(), submission({ requestNonce: other }));

      expect(db.prepare('SELECT COUNT(*) AS n FROM review_authorizations').get()).toEqual({ n: 0 });
    });

    it('uses the stored nullifier, ignoring any the client supplies', async () => {
      seedVerification({ nullifier: '12345' });

      const body = (await (
        await post(buildApp(), submission({ nullifier: '999', nullifierHash: '999' }))
      ).json()) as PrepareBody;

      // The client's value is nowhere; the stored one is bound.
      expect(body.typed_data.message['nullifier']).toBe(nullifierToBytes32('12345'));
      expect(findReviewAuthorization(db, body.challenge_id)?.nullifier).toBe(
        nullifierToBytes32('12345'),
      );
    });

    it('computes feedbackHash from the content, ignoring any the client sends', async () => {
      // A client-chosen hash would let the signed evidence pointer diverge from
      // the text the server was actually given.
      seedVerification();
      const attackerHash = `0x${'ee'.repeat(32)}`;

      const body = (await (
        await post(
          buildApp(),
          submission({ feedbackHash: attackerHash, feedback_hash: attackerHash }),
        )
      ).json()) as PrepareBody;

      expect(body.feedback_hash).toBe(keccak256(toBytes(CONTENT)));
      expect(body.typed_data.message['feedbackHash']).toBe(keccak256(toBytes(CONTENT)));
      expect(body.feedback_hash).not.toBe(attackerHash);
      expect(findReviewAuthorization(db, body.challenge_id)?.feedbackHash).toBe(
        keccak256(toBytes(CONTENT)),
      );
    });

    it('writes no challenge when the verification is missing', async () => {
      await post(buildApp(), submission());

      expect(db.prepare('SELECT COUNT(*) AS n FROM review_authorizations').get()).toEqual({ n: 0 });
    });
  });

  describe('request validation', () => {
    it('rejects a non-JSON body', async () => {
      const res = await buildApp().request(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_json' });
    });

    it.each([
      ['a missing agentId', { agentId: undefined }, 'invalid_agent_id'],
      ['a numeric agentId', { agentId: 42 }, 'invalid_agent_id'],
      ['a zero agentId', { agentId: '0' }, 'invalid_agent_id'],
      ['a missing reviewer', { reviewer: undefined }, 'invalid_reviewer'],
      ['a malformed reviewer', { reviewer: '0xdead' }, 'invalid_reviewer'],
      ['a missing value', { value: undefined }, 'invalid_value'],
      ['a fractional value', { value: 80.5 }, 'invalid_value'],
      ['a string value', { value: '80' }, 'invalid_value'],
      ['a missing valueDecimals', { valueDecimals: undefined }, 'invalid_value_decimals'],
      ['a missing reviewType', { reviewType: undefined }, 'invalid_review_type'],
      ['a malformed receiptId', { receiptId: '0xbeef' }, 'invalid_receipt_id'],
      ['a missing content', { content: undefined }, 'invalid_content'],
      ['an empty content', { content: '' }, 'invalid_content'],
      ['a non-string content', { content: 42 }, 'invalid_content'],
    ])('rejects %s', async (_label, overrides, error) => {
      seedVerification();
      const res = await post(buildApp(), submission(overrides));

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error });
    });

    it('rejects content above the size limit', async () => {
      seedVerification();
      const res = await post(
        buildApp(),
        submission({ content: 'x'.repeat(MAX_CONTENT_BYTES + 1) }),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'content_too_large' });
    });

    it('accepts content exactly at the size limit', async () => {
      seedVerification();
      const res = await post(buildApp(), submission({ content: 'x'.repeat(MAX_CONTENT_BYTES) }));

      expect(res.status).toBe(200);
    });

    it('measures content in bytes, not characters', async () => {
      seedVerification();
      // Four bytes per emoji, so this exceeds the limit despite being shorter.
      const res = await post(
        buildApp(),
        submission({ content: '😀'.repeat(MAX_CONTENT_BYTES / 4 + 1) }),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'content_too_large' });
    });
  });

  describe('review content rules are the gateway rules', () => {
    it.each([
      ['a rating above the range', { value: 101 }],
      ['a negative rating', { value: -1 }],
      ['nonzero decimals', { valueDecimals: 1 }],
      ['an unknown review type', { reviewType: 3 }],
      ['a wallet review on the World ID path', { reviewType: 2 }],
      ['a free review carrying a receipt', { receiptId: `0x${'77'.repeat(32)}` }],
      ['a paid review with a zero receipt', { reviewType: REVIEW_TYPE.PAID }],
    ])('rejects %s', async (_label, overrides) => {
      seedVerification();
      const res = await post(buildApp(), submission(overrides));

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_review_content' });
    });

    it('reports which fields were wrong', async () => {
      seedVerification();
      const res = await post(buildApp(), submission({ value: 500, valueDecimals: 3 }));

      const body = (await res.json()) as { issues: { field: string }[] };
      expect(body.issues.map((i) => i.field)).toEqual(
        expect.arrayContaining(['value', 'valueDecimals']),
      );
    });

    it('writes no challenge when the content is invalid', async () => {
      seedVerification();
      await post(buildApp(), submission({ value: 101 }));

      expect(db.prepare('SELECT COUNT(*) AS n FROM review_authorizations').get()).toEqual({ n: 0 });
    });

    it.each([0, 1, 50, 100])('accepts a rating of %i', async (value) => {
      seedVerification();
      expect((await post(buildApp(), submission({ value }))).status).toBe(200);
    });
  });

  describe('storage failures', () => {
    it('returns an opaque 500 and leaves no partial state', async () => {
      seedVerification();
      // A trigger that aborts the insert stands in for any storage fault.
      db.exec(`
        CREATE TRIGGER block_authorizations BEFORE INSERT ON review_authorizations
        BEGIN SELECT RAISE(ABORT, 'disk is on fire at /var/db/receipts.db'); END;
      `);

      const res = await post(buildApp(), submission());

      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe(JSON.stringify({ error: 'challenge_not_persisted' }));
      // The database path in the trigger message must not escape.
      expect(text).not.toContain('/var/db');

      expect(db.prepare('SELECT COUNT(*) AS n FROM review_authorizations').get()).toEqual({ n: 0 });
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM world_id_verifications WHERE authorized_at IS NOT NULL',
          )
          .get(),
      ).toEqual({ n: 0 });
    });
  });

  describe('confidentiality', () => {
    it('leaks no secrets in a successful response', async () => {
      seedVerification();
      const text = await (await post(buildApp(), submission())).text();

      expect(text).not.toContain(VALID_ENV.WORLD_SIGNING_KEY);
      expect(text).not.toContain(VALID_ENV.RECORD_SERVER_PRIVATE_KEY);
      expect(text).not.toContain(VALID_ENV.RPC_URL);
      // The raw decimal nullifier is not echoed; only its bytes32 form is bound.
      expect(text).not.toContain('"nullifier":"7"');
    });

    it('rejects GET', async () => {
      expect((await buildApp().request(ENDPOINT)).status).toBe(404);
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAddress, keccak256, toBytes } from 'viem';
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { createApp } from '../src/app.js';
import { IN_MEMORY, openDatabase } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { createReviewAuthorization } from '../src/db/reviewAuthorizations.js';
import { recordWorldIdRequest } from '../src/db/worldIdRequests.js';
import { consumeAndRecordVerification } from '../src/db/worldIdVerifications.js';
import {
  consumeWalletReviewAuthorization,
  createWalletReviewAuthorization,
  findWalletReviewAuthorization,
} from '../src/db/walletReviewAuthorizations.js';
import { submitFunctionFor } from '../src/routes/reviewAttest.js';
import { authorizationDomain, AUTHORIZATION_TYPES } from '../src/signing/reviewAuthorization.js';
import { feedbackUriFor } from '../src/signing/feedbackUri.js';
import {
  REVIEW_TYPE,
  ZERO_BYTES32,
  nullifierToBytes32,
  walletNullifier,
} from '../src/signing/reviewContent.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from '../src/db/postgres/schema.js';
import { VALID_ENV, appDeps, testAttestationSigner } from './fixtures.js';

const PREPARE = '/api/reviews/wallet/prepare';
const ATTEST = '/api/reviews/attest';
const STATUS = '/api/reviews/wallet/status';
const NOW = 1_793_740_600;
const TTL = 300;
const ATT_TTL = 3_600;
const CONTENT = 'Fast, accurate, and honest about what it could not do.';
const FEEDBACK_HASH = keccak256(toBytes(CONTENT));

const REVIEWER_KEY: Hex = `0x${'44'.repeat(32)}`;
const OTHER_KEY: Hex = `0x${'55'.repeat(32)}`;
const REVIEWER = privateKeyToAddress(REVIEWER_KEY);
const CHAIN_ID = Number(VALID_ENV.CHAIN_ID);
const GATEWAY = getAddress(VALID_ENV.REVIEW_GATEWAY_ADDRESS);

interface PrepareBody {
  challenge_id: Hex;
  deadline: number;
  feedback_hash: Hex;
  review_type: number;
  verification: string;
  typed_data: {
    domain: Record<string, unknown>;
    types: typeof AUTHORIZATION_TYPES;
    primaryType: 'ReviewAuthorization';
    message: Record<string, string | number>;
  };
}

interface AttestBody {
  attestation: Record<string, unknown> & { signature: Hex };
  gateway: Address;
  submit_function: string;
  submitted: boolean;
}

describe('wallet-verified reviews', () => {
  let db: Db;
  let clock: number;

  function buildApp(overrides: Parameters<typeof appDeps>[1] = {}) {
    return createApp(appDeps(db, { now: () => clock, walletReviewsEnabled: true, ...overrides }));
  }

  function request(app: ReturnType<typeof createApp>, path: string, body: unknown) {
    return app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function prepareBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      agentId: '7',
      reviewer: REVIEWER,
      value: 80,
      valueDecimals: 0,
      content: CONTENT,
      ...overrides,
    };
  }

  async function prepare(
    app: ReturnType<typeof createApp>,
    overrides: Record<string, unknown> = {},
  ): Promise<PrepareBody> {
    const res = await request(app, PREPARE, prepareBody(overrides));
    expect(res.status).toBe(200);
    return (await res.json()) as PrepareBody;
  }

  /** Sign the typed data exactly as the server returned it. */
  async function sign(
    body: PrepareBody,
    key: Hex = REVIEWER_KEY,
    domainOverrides: Record<string, unknown> = {},
    messageOverrides: Record<string, unknown> = {},
  ): Promise<Hex> {
    // The wire form carries uint/int as decimal strings; a wallet encodes them
    // as integers, so restore bigints for exactly the integer-typed fields.
    const message: Record<string, unknown> = { ...body.typed_data.message, ...messageOverrides };
    for (const field of body.typed_data.types.ReviewAuthorization) {
      if (/^u?int/.test(field.type)) message[field.name] = BigInt(message[field.name] as string);
    }
    return privateKeyToAccount(key).signTypedData({
      domain: {
        ...(body.typed_data.domain as object),
        ...domainOverrides,
      } as never,
      types: body.typed_data.types,
      primaryType: body.typed_data.primaryType,
      message: message as never,
    });
  }

  const attest = (app: ReturnType<typeof createApp>, challengeId: Hex, signature: Hex) =>
    request(app, ATTEST, { challengeId, signature });

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
    clock = NOW;
  });

  afterEach(() => {
    db.close();
  });

  describe('POST /api/reviews/wallet/prepare', () => {
    it('issues an expiring wallet-only challenge', async () => {
      const body = await prepare(buildApp());

      expect(body.challenge_id).toMatch(/^0x[0-9a-f]{64}$/);
      expect(body.deadline).toBe(NOW + TTL);
      expect(body.feedback_hash).toBe(FEEDBACK_HASH);
      expect(body.review_type).toBe(2);
      expect(body.verification).toBe('wallet_only');
    });

    it('derives type, receipt, nullifier and hash on the server', async () => {
      const body = await prepare(buildApp());
      const m = body.typed_data.message;

      expect(m['reviewType']).toBe(REVIEW_TYPE.WALLET);
      expect(m['receiptId']).toBe(ZERO_BYTES32);
      expect(m['nullifier']).toBe(walletNullifier(REVIEWER));
      expect(m['feedbackHash']).toBe(FEEDBACK_HASH);
      expect(m['agentId']).toBe('7');
      expect(m['reviewer']).toBe(REVIEWER);
      expect(m['value']).toBe('80');
      expect(m['nonce']).toBe(body.challenge_id);
    });

    it('binds the chain and the gateway through the EIP-712 domain', async () => {
      const body = await prepare(buildApp());
      expect(body.typed_data.domain).toEqual(authorizationDomain(CHAIN_ID, GATEWAY));
    });

    it('persists the challenge and the content, and spends nothing', async () => {
      const body = await prepare(buildApp());
      const row = await findWalletReviewAuthorization(db, body.challenge_id);

      expect(row).toMatchObject({
        agentId: '7',
        reviewer: REVIEWER,
        reviewType: 2,
        receiptId: ZERO_BYTES32,
        consumedAt: null,
        signature: null,
        deadline: NOW + TTL,
      });
      expect(
        db
          .prepare('SELECT COUNT(*) AS n FROM review_contents WHERE feedback_hash = ?')
          .get(FEEDBACK_HASH),
      ).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM review_authorizations').get()).toEqual({
        n: 0,
      });
    });

    it.each([
      'reviewType',
      'receiptId',
      'nullifier',
      'requestNonce',
      'challenge_id',
      'verification',
    ])('rejects the client-supplied field %s', async (field) => {
      const res = await request(buildApp(), PREPARE, prepareBody({ [field]: 'x' }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'unknown_fields', fields: [field] });
      expect(db.prepare('SELECT COUNT(*) AS n FROM wallet_review_authorizations').get()).toEqual({
        n: 0,
      });
    });

    it('lists every unknown field, never their values', async () => {
      const res = await request(
        buildApp(),
        PREPARE,
        prepareBody({ reviewType: 0, nullifier: '0xsecret', requestNonce: 'abc' }),
      );
      const text = await res.text();

      expect(JSON.parse(text)).toEqual({
        error: 'unknown_fields',
        fields: ['nullifier', 'requestNonce', 'reviewType'],
      });
      expect(text).not.toContain('secret');
    });

    it.each([
      ['a rating above the range', { value: 101 }, 'invalid_review_content'],
      ['a negative rating', { value: -1 }, 'invalid_review_content'],
      ['a fractional rating', { value: 80.5 }, 'invalid_value'],
      ['nonzero decimals', { valueDecimals: 1 }, 'invalid_review_content'],
      ['a numeric agentId', { agentId: 7 }, 'invalid_agent_id'],
      ['a bad agentId', { agentId: '-1' }, 'invalid_agent_id'],
      ['a non-address reviewer', { reviewer: '0x123' }, 'invalid_reviewer'],
      ['the zero address', { reviewer: `0x${'00'.repeat(20)}` }, 'invalid_review_content'],
      ['empty content', { content: '' }, 'invalid_content'],
    ])('rejects %s', async (_label, overrides, error) => {
      const res = await request(buildApp(), PREPARE, prepareBody(overrides));

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error });
      expect(db.prepare('SELECT COUNT(*) AS n FROM wallet_review_authorizations').get()).toEqual({
        n: 0,
      });
    });

    it.each([0, 1, 50, 100])('accepts a rating of %i', async (value) => {
      expect((await request(buildApp(), PREPARE, prepareBody({ value }))).status).toBe(200);
    });

    it('refuses a wallet that already has a spent review for the agent', async () => {
      const app = buildApp();
      const first = await prepare(app);
      expect((await attest(app, first.challenge_id, await sign(first))).status).toBe(200);

      const res = await request(app, PREPARE, prepareBody());
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'wallet_already_reviewed' });
    });

    it('treats checksum casing as the same wallet', async () => {
      const app = buildApp();
      const first = await prepare(app);
      await attest(app, first.challenge_id, await sign(first));

      const res = await request(app, PREPARE, prepareBody({ reviewer: REVIEWER.toLowerCase() }));
      expect(res.status).toBe(409);
    });

    it('lets the same wallet review a different agent', async () => {
      const app = buildApp();
      const first = await prepare(app);
      await attest(app, first.challenge_id, await sign(first));

      expect((await request(app, PREPARE, prepareBody({ agentId: '8' }))).status).toBe(200);
    });

    it('does not let an unspent challenge block the wallet', async () => {
      const app = buildApp();
      await prepare(app);
      expect((await request(app, PREPARE, prepareBody())).status).toBe(200);
    });
  });

  describe('feature flag', () => {
    it('is off by default', async () => {
      const app = createApp(appDeps(db, { now: () => clock }));
      const res = await request(app, PREPARE, prepareBody());

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'wallet_reviews_disabled' });
      expect((await app.request(STATUS)).status).toBe(200);
      expect(await (await app.request(STATUS)).json()).toEqual({ enabled: false });
      expect(db.prepare('SELECT COUNT(*) AS n FROM wallet_review_authorizations').get()).toEqual({
        n: 0,
      });
    });

    it('reports enabled when on', async () => {
      expect(await (await buildApp().request(STATUS)).json()).toEqual({ enabled: true });
    });

    it('refuses to attest a wallet challenge issued while it was on', async () => {
      const issued = await prepare(buildApp());
      const signature = await sign(issued);

      const res = await attest(
        buildApp({ walletReviewsEnabled: false }),
        issued.challenge_id,
        signature,
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'wallet_reviews_disabled' });
      // Not spent: turning the flag back on lets the same signature through.
      expect((await attest(buildApp(), issued.challenge_id, signature)).status).toBe(200);
    });
  });

  describe('POST /api/reviews/attest for a wallet challenge', () => {
    it('attests with submitWalletReview and the wallet nullifier', async () => {
      const app = buildApp();
      const issued = await prepare(app);

      const res = await attest(app, issued.challenge_id, await sign(issued));
      expect(res.status).toBe(200);

      const body = (await res.json()) as AttestBody;
      expect(body.submit_function).toBe('submitWalletReview');
      expect(body.submitted).toBe(false);
      expect(body.gateway).toBe(GATEWAY);
      expect(body.attestation).toMatchObject({
        agentId: '7',
        reviewer: REVIEWER,
        nullifier: walletNullifier(REVIEWER),
        value: '80',
        valueDecimals: 0,
        feedbackHash: FEEDBACK_HASH,
        feedbackURI: feedbackUriFor(VALID_ENV.REVIEW_CONTENT_BASE_URL, FEEDBACK_HASH),
        reviewType: 2,
        receiptId: ZERO_BYTES32,
        expiry: String(NOW + ATT_TTL),
      });
    });

    it('signs an attestation the gateway digest verifies', async () => {
      const app = buildApp();
      const issued = await prepare(app);
      const body = (await (
        await attest(app, issued.challenge_id, await sign(issued))
      ).json()) as AttestBody;

      const verified = await testAttestationSigner().verify(
        {
          agentId: 7n,
          nullifier: walletNullifier(REVIEWER),
          reviewer: REVIEWER,
          expiry: BigInt(NOW + ATT_TTL),
          value: 80n,
          valueDecimals: 0,
          feedbackHash: FEEDBACK_HASH,
          feedbackURI: feedbackUriFor(VALID_ENV.REVIEW_CONTENT_BASE_URL, FEEDBACK_HASH),
          reviewType: 2,
          receiptId: ZERO_BYTES32,
        },
        body.attestation.signature,
      );
      expect(verified).toBe(true);
    });

    it('marks the challenge spent with the accepted signature', async () => {
      const app = buildApp();
      const issued = await prepare(app);
      const signature = await sign(issued);
      await attest(app, issued.challenge_id, signature);

      expect(await findWalletReviewAuthorization(db, issued.challenge_id)).toMatchObject({
        consumedAt: NOW,
        signature,
      });
    });

    it('rejects a signature by a different wallet and leaves the challenge spendable', async () => {
      const app = buildApp();
      const issued = await prepare(app);

      const res = await attest(app, issued.challenge_id, await sign(issued, OTHER_KEY));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'invalid_wallet_signature',
        reason: 'signer_mismatch',
      });
      expect((await findWalletReviewAuthorization(db, issued.challenge_id))?.consumedAt).toBeNull();
      expect((await attest(app, issued.challenge_id, await sign(issued))).status).toBe(200);
    });

    it('rejects a malformed signature', async () => {
      const app = buildApp();
      const issued = await prepare(app);

      const res = await attest(app, issued.challenge_id, `0x${'ab'.repeat(65)}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_wallet_signature' });
    });

    it('rejects an expired challenge', async () => {
      const app = buildApp();
      const issued = await prepare(app);
      const signature = await sign(issued);

      clock = NOW + TTL;
      const res = await attest(app, issued.challenge_id, signature);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'challenge_expired' });
      expect((await findWalletReviewAuthorization(db, issued.challenge_id))?.consumedAt).toBeNull();
    });

    it('rejects a signature made for another chain', async () => {
      const app = buildApp();
      const issued = await prepare(app);

      const res = await attest(
        app,
        issued.challenge_id,
        await sign(issued, REVIEWER_KEY, { chainId: 1 }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_wallet_signature' });
    });

    it('rejects a signature made for another gateway', async () => {
      const app = buildApp();
      const issued = await prepare(app);

      const res = await attest(
        app,
        issued.challenge_id,
        await sign(issued, REVIEWER_KEY, { verifyingContract: `0x${'99'.repeat(20)}` }),
      );
      expect(res.status).toBe(400);
    });

    it('rejects a signature made for another agent', async () => {
      const app = buildApp();
      const issued = await prepare(app);

      // The wallet signed agent 8; the stored challenge is for agent 7.
      const res = await attest(
        app,
        issued.challenge_id,
        await sign(issued, REVIEWER_KEY, {}, { agentId: '8' }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_wallet_signature' });
    });

    it('does not let a signature for one challenge spend another', async () => {
      const app = buildApp();
      const a = await prepare(app);
      const b = await prepare(app, { agentId: '8' });

      const res = await attest(app, b.challenge_id, await sign(a));
      expect(res.status).toBe(400);
    });

    it('answers an identical retry from the original result, a different signature as a conflict', async () => {
      const app = buildApp();
      const issued = await prepare(app);
      const signature = await sign(issued);

      expect((await attest(app, issued.challenge_id, signature)).status).toBe(200);
      expect((await attest(app, issued.challenge_id, signature)).status).toBe(200);

      // The malleated twin of the same signature (s -> n - s, v flipped) is a
      // valid, different byte string from the same wallet. It must not be
      // accepted as a second spend of the challenge.
      const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const r = signature.slice(2, 66);
      const sBig = BigInt(`0x${signature.slice(66, 130)}`);
      const v = parseInt(signature.slice(130, 132), 16);
      const twin =
        `0x${r}${(n - sBig).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
      expect(twin).not.toBe(signature);

      const conflict = await attest(app, issued.challenge_id, twin);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ error: 'nonce_consumed' });
    });

    it('refuses a second challenge for a wallet that already has a spent one', async () => {
      const app = buildApp();
      const first = await prepare(app);
      const second = await prepare(app);

      expect((await attest(app, first.challenge_id, await sign(first))).status).toBe(200);
      const res = await attest(app, second.challenge_id, await sign(second));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'wallet_already_reviewed' });
      expect((await findWalletReviewAuthorization(db, second.challenge_id))?.consumedAt).toBeNull();
    });

    it('lets exactly one of several concurrent challenges for one wallet win', async () => {
      const app = buildApp();
      const issued = await Promise.all([prepare(app), prepare(app), prepare(app), prepare(app)]);
      expect(new Set(issued.map((i) => i.challenge_id)).size).toBe(4);

      const results = await Promise.all(
        issued.map(async (i) => attest(app, i.challenge_id, await sign(i))),
      );
      const statuses = results.map((r) => r.status).sort();

      expect(statuses).toEqual([200, 409, 409, 409]);
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM wallet_review_authorizations WHERE consumed_at IS NOT NULL',
          )
          .get(),
      ).toEqual({ n: 1 });
    });

    it('returns 404 for an unknown challenge', async () => {
      const res = await attest(buildApp(), `0x${'12'.repeat(32)}`, `0x${'ab'.repeat(65)}`);
      expect(res.status).toBe(404);
    });
  });

  describe('submit function mapping', () => {
    it('maps each type to its own entry point', () => {
      expect(submitFunctionFor(REVIEW_TYPE.FREE)).toBe('submitFreeReview');
      expect(submitFunctionFor(REVIEW_TYPE.PAID)).toBe('submitPaidReview');
      expect(submitFunctionFor(REVIEW_TYPE.WALLET)).toBe('submitWalletReview');
    });

    it.each([3, 4, 255, -1, 1.5, Number.NaN])('has no entry point for %o', (type) => {
      expect(submitFunctionFor(type)).toBeUndefined();
    });

    it('fails closed on a wallet type stored in the World ID table', async () => {
      // Insert directly: the World ID table has no CHECK on review_type.
      recordWorldIdRequest(db, {
        nonce: `0x${'ab'.repeat(32)}`,
        rpId: VALID_ENV.WORLD_RP_ID,
        action: 'review-agent-7',
        agentId: '7',
        createdAt: NOW - 100,
        expiresAt: NOW + 1000,
      });
      consumeAndRecordVerification(db, {
        nonce: `0x${'ab'.repeat(32)}`,
        rpId: VALID_ENV.WORLD_RP_ID,
        action: 'review-agent-7',
        agentId: '7',
        reviewer: REVIEWER,
        nullifier: '7',
        now: NOW - 50,
      });
      const challenge = `0x${'66'.repeat(32)}` as Hex;
      createReviewAuthorization(
        db,
        challenge,
        {
          verificationNonce: `0x${'ab'.repeat(32)}`,
          agentId: '7',
          reviewer: REVIEWER,
          nullifier: nullifierToBytes32('7'),
          value: 80,
          valueDecimals: 0,
          feedbackHash: FEEDBACK_HASH,
          reviewType: REVIEW_TYPE.WALLET,
          receiptId: ZERO_BYTES32,
          deadline: NOW + 300,
        },
        NOW,
      );

      const res = await attest(buildApp(), challenge, `0x${'ab'.repeat(65)}`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'unsupported_review_type' });
    });

    it('still routes free World ID challenges to submitFreeReview', async () => {
      // Regression: the shared route's existing behaviour, with the flag on.
      // Full coverage lives in reviewAttest.test.ts; this pins the mapping.
      expect(submitFunctionFor(REVIEW_TYPE.FREE)).toBe('submitFreeReview');
    });
  });

  describe('migration 006 and storage constraints', () => {
    const insert = (overrides: Record<string, unknown> = {}) => {
      const row = {
        nonce: `0x${'01'.repeat(32)}`,
        agent_id: '7',
        reviewer: REVIEWER,
        nullifier: walletNullifier(REVIEWER),
        value: 80,
        value_decimals: 0,
        feedback_hash: FEEDBACK_HASH,
        review_type: 2,
        receipt_id: ZERO_BYTES32,
        deadline: NOW + 300,
        created_at: NOW,
        consumed_at: null,
        signature: null,
        ...overrides,
      };
      db.prepare(
        `INSERT INTO wallet_review_authorizations
           (nonce, agent_id, reviewer, nullifier, value, value_decimals, feedback_hash,
            review_type, receipt_id, deadline, created_at, consumed_at, signature)
         VALUES (@nonce, @agent_id, @reviewer, @nullifier, @value, @value_decimals,
                 @feedback_hash, @review_type, @receipt_id, @deadline, @created_at,
                 @consumed_at, @signature)`,
      ).run(row);
    };

    it.each([
      ['review_type 0', { review_type: 0 }],
      ['review_type 1', { review_type: 1 }],
      ['a nonzero receipt', { receipt_id: `0x${'77'.repeat(32)}` }],
      ['a rating above 100', { value: 101 }],
      ['nonzero decimals', { value_decimals: 1 }],
      ['consumed_at without a signature', { consumed_at: NOW }],
      ['a signature without consumed_at', { signature: '0xabcd' }],
    ])('refuses %s at the database', (_label, overrides) => {
      expect(() => insert(overrides)).toThrow(/CHECK constraint/);
    });

    it('refuses a duplicate challenge id', () => {
      insert();
      expect(() => insert()).toThrow(/UNIQUE|PRIMARY/);
    });

    it('allows several unspent challenges for one wallet and agent', () => {
      insert({ nonce: `0x${'01'.repeat(32)}` });
      insert({ nonce: `0x${'02'.repeat(32)}` });
    });

    it('refuses two SPENT rows for one wallet and agent', () => {
      insert({ nonce: `0x${'01'.repeat(32)}`, consumed_at: NOW, signature: '0xaa' });
      expect(() =>
        insert({ nonce: `0x${'02'.repeat(32)}`, consumed_at: NOW, signature: '0xbb' }),
      ).toThrow(/UNIQUE/);
    });

    it('classifies a second spend for one wallet as wallet_already_reviewed', () => {
      const params = {
        agentId: '7',
        reviewer: REVIEWER,
        nullifier: walletNullifier(REVIEWER),
        value: 80,
        valueDecimals: 0,
        feedbackHash: FEEDBACK_HASH,
        reviewType: 2,
        receiptId: ZERO_BYTES32,
        deadline: NOW + 300,
      };
      const a = `0x${'01'.repeat(32)}` as Hex;
      const b = `0x${'02'.repeat(32)}` as Hex;
      createWalletReviewAuthorization(db, a, params, NOW);
      createWalletReviewAuthorization(db, b, params, NOW);

      expect(
        consumeWalletReviewAuthorization(db, { nonce: a, signature: '0xaa', now: NOW }),
      ).toMatchObject({ ok: true, replayed: false });
      expect(
        consumeWalletReviewAuthorization(db, { nonce: b, signature: '0xbb', now: NOW }),
      ).toEqual({
        ok: false,
        reason: 'wallet_already_reviewed',
      });
    });

    it('is applied to a database that stopped at migration 005', () => {
      const older = openDatabase(IN_MEMORY);
      runMigrations(older, MIGRATIONS.slice(0, 5));

      expect(runMigrations(older)).toEqual(['006_wallet_review_authorizations']);
      older.close();
    });

    it('is mirrored in the PostgreSQL schema at a bumped version', () => {
      expect(SCHEMA_VERSION).toBe(2);
      expect(SCHEMA_SQL).toContain('wallet_review_authorizations');
      expect(SCHEMA_SQL).toContain('review_type    BIGINT  NOT NULL CHECK (review_type = 2)');
      expect(SCHEMA_SQL).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_review_spent[\s\S]*WHERE consumed_at IS NOT NULL/,
      );
    });
  });
});

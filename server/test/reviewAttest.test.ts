import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, keccak256, toBytes } from 'viem';
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { createApp } from '../src/app.js';
import { IN_MEMORY, openDatabase } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { recordWorldIdRequest } from '../src/db/worldIdRequests.js';
import { consumeAndRecordVerification } from '../src/db/worldIdVerifications.js';
import {
  createReviewAuthorization,
  findReviewAuthorization,
} from '../src/db/reviewAuthorizations.js';
import { authorizationTypedData } from '../src/signing/reviewAuthorization.js';
import { REVIEW_TYPE, ZERO_BYTES32, nullifierToBytes32 } from '../src/signing/reviewContent.js';
import { ERC1271_MAGIC_VALUE } from '../src/signing/walletSignature.js';
import type { ContractWalletReader, VerificationBlock } from '../src/signing/walletSignature.js';
import { createAttestationSigner } from '../src/signing/signer.js';
import { feedbackUriFor } from '../src/signing/feedbackUri.js';
import { MAX_SIGNATURE_BYTES } from '../src/routes/reviewAttest.js';
import { VALID_ENV, appDeps, testAttestationSigner } from './fixtures.js';

const ENDPOINT = '/api/reviews/attest';
const NOW = 1_793_740_600;
const TTL = 3_600;
const RP_NONCE = `0x${'ab'.repeat(32)}`;
const CHALLENGE = `0x${'55'.repeat(32)}` as Hex;
const DEADLINE = NOW + 300;
const NULLIFIER_DECIMAL = '7';
const NULLIFIER = nullifierToBytes32(NULLIFIER_DECIMAL);
const FEEDBACK_HASH = keccak256(toBytes('A precise and honest answer.'));
/** What the Record Server derives and signs; never supplied by a caller. */
const FEEDBACK_URI = feedbackUriFor(VALID_ENV.REVIEW_CONTENT_BASE_URL, FEEDBACK_HASH);

/** The reviewer's wallet; deterministic and clearly synthetic. */
const REVIEWER_KEY: Hex = `0x${'44'.repeat(32)}`;
const OTHER_KEY: Hex = `0x${'55'.repeat(32)}`;
const REVIEWER = privateKeyToAddress(REVIEWER_KEY);

const CHAIN_ID = Number(VALID_ENV.CHAIN_ID);
const GATEWAY = getAddress(VALID_ENV.REVIEW_GATEWAY_ADDRESS);
const HEAD: VerificationBlock = { number: 21_000_000n, hash: `0x${'11'.repeat(32)}` };

interface AttestBody {
  readonly attestation: Record<string, unknown> & { signature: Hex };
  readonly gateway: Address;
  readonly submit_function: string;
  readonly submitted: boolean;
}

describe('POST /api/reviews/attest', () => {
  let db: Db;

  function seedChallenge(
    overrides: {
      nonce?: Hex;
      reviewer?: Address;
      value?: number;
      reviewType?: number;
      receiptId?: Hex;
      deadline?: number;
      agentId?: string;
      /** Must differ per challenge for one agent: UNIQUE(agent_id, nullifier). */
      nullifierDecimal?: string;
    } = {},
  ): Hex {
    const agentId = overrides.agentId ?? '42';
    const nullifierDecimal = overrides.nullifierDecimal ?? NULLIFIER_DECIMAL;
    const action = `review-agent-${agentId}`;
    // A distinct RP nonce per seeded challenge: 0x + 64 hex, with the counter
    // in the last two characters.
    const rpNonce = `${RP_NONCE.slice(0, 64)}${(seedChallenge.counter++)
      .toString(16)
      .padStart(2, '0')}`;

    recordWorldIdRequest(db, {
      nonce: rpNonce,
      rpId: VALID_ENV.WORLD_RP_ID,
      action,
      agentId,
      createdAt: NOW - 400,
      expiresAt: NOW + 1000,
    });
    consumeAndRecordVerification(db, {
      nonce: rpNonce,
      rpId: VALID_ENV.WORLD_RP_ID,
      action,
      agentId,
      reviewer: overrides.reviewer ?? REVIEWER,
      nullifier: nullifierDecimal,
      now: NOW - 300,
    });

    const nonce = overrides.nonce ?? CHALLENGE;
    createReviewAuthorization(
      db,
      nonce,
      {
        verificationNonce: rpNonce,
        agentId,
        reviewer: overrides.reviewer ?? REVIEWER,
        nullifier: nullifierToBytes32(nullifierDecimal),
        value: overrides.value ?? 80,
        valueDecimals: 0,
        feedbackHash: FEEDBACK_HASH,
        reviewType: overrides.reviewType ?? REVIEW_TYPE.FREE,
        receiptId: overrides.receiptId ?? ZERO_BYTES32,
        deadline: overrides.deadline ?? DEADLINE,
      },
      NOW - 10,
    );
    return nonce;
  }
  seedChallenge.counter = 0;

  /** The wallet signature over a stored challenge. */
  async function signChallenge(nonce: Hex, key: Hex = REVIEWER_KEY): Promise<Hex> {
    const record = findReviewAuthorization(db, nonce);
    if (record === undefined) throw new Error('challenge not seeded');

    const typedData = authorizationTypedData(
      {
        agentId: BigInt(record.agentId),
        nullifier: record.nullifier,
        reviewer: getAddress(record.reviewer),
        value: BigInt(record.value),
        valueDecimals: record.valueDecimals,
        feedbackHash: record.feedbackHash,
        reviewType: record.reviewType,
        receiptId: record.receiptId,
        nonce: record.nonce,
        deadline: BigInt(record.deadline),
      },
      CHAIN_ID,
      GATEWAY,
    );

    return privateKeyToAccount(key).signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });
  }

  /** A contract-wallet reader with fixed answers. */
  function fakeReader(
    overrides: { code?: Hex | undefined; magic?: Hex | (() => never) } = {},
  ): ContractWalletReader {
    return {
      async getBlock() {
        return HEAD;
      },
      async getCode() {
        return 'code' in overrides ? overrides.code : '0x60806040';
      },
      async isValidSignature() {
        const v = overrides.magic ?? ERC1271_MAGIC_VALUE;
        if (typeof v === 'function') return v();
        return v as Hex;
      },
    };
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

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
    seedChallenge.counter = 0;
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  describe('valid EOA signature', () => {
    it('consumes the challenge and returns a signed attestation', async () => {
      seedChallenge();
      const signature = await signChallenge(CHALLENGE);

      const res = await post(buildApp(), { challengeId: CHALLENGE, signature });
      expect(res.status).toBe(200);

      const body = (await res.json()) as AttestBody;
      expect(body.submitted).toBe(false);
      expect(body.gateway).toBe(GATEWAY);
      expect(body.submit_function).toBe('submitFreeReview');
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBe(NOW);
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM world_id_verifications WHERE authorized_at IS NOT NULL',
          )
          .get(),
      ).toEqual({ n: 1 });
    });

    it('names submitPaidReview for a paid review', async () => {
      const receiptId = `0x${'77'.repeat(32)}` as Hex;
      seedChallenge({ reviewType: REVIEW_TYPE.PAID, receiptId });
      const signature = await signChallenge(CHALLENGE);

      const body = (await (
        await post(buildApp(), { challengeId: CHALLENGE, signature })
      ).json()) as AttestBody;

      expect(body.submit_function).toBe('submitPaidReview');
      expect(body.attestation['receiptId']).toBe(receiptId);
    });
  });

  describe('the attestation binds all nine gateway fields', () => {
    it('carries every field from the stored challenge', async () => {
      seedChallenge({ value: 95 });
      const signature = await signChallenge(CHALLENGE);

      const body = (await (
        await post(buildApp(), { challengeId: CHALLENGE, signature })
      ).json()) as AttestBody;

      const { signature: attSig, ...fields } = body.attestation;
      expect(fields).toEqual({
        agentId: '42',
        nullifier: NULLIFIER,
        reviewer: REVIEWER,
        expiry: String(NOW + TTL),
        value: '95',
        valueDecimals: 0,
        feedbackHash: FEEDBACK_HASH,
        feedbackURI: FEEDBACK_URI,
        reviewType: REVIEW_TYPE.FREE,
        receiptId: ZERO_BYTES32,
      });
      expect(attSig).toMatch(/^0x[0-9a-f]{130}$/);
    });

    it('is a signature the gateway will accept from the Record Server', async () => {
      seedChallenge();
      const signature = await signChallenge(CHALLENGE);

      const body = (await (
        await post(buildApp(), { challengeId: CHALLENGE, signature })
      ).json()) as AttestBody;

      // Recovers to the configured signer over the exact ten fields.
      const signer = testAttestationSigner();
      const verified = await signer.verify(
        {
          agentId: 42n,
          nullifier: NULLIFIER,
          reviewer: REVIEWER,
          expiry: BigInt(NOW + TTL),
          value: 80n,
          valueDecimals: 0,
          feedbackHash: FEEDBACK_HASH,
          feedbackURI: FEEDBACK_URI,
          reviewType: REVIEW_TYPE.FREE,
          receiptId: ZERO_BYTES32,
        },
        body.attestation.signature,
      );

      expect(verified).toBe(true);
      expect(signer.address).toBe(privateKeyToAddress(VALID_ENV.RECORD_SERVER_PRIVATE_KEY));
    });

    it('does not verify against a tampered field', async () => {
      seedChallenge();
      const signature = await signChallenge(CHALLENGE);
      const body = (await (
        await post(buildApp(), { challengeId: CHALLENGE, signature })
      ).json()) as AttestBody;

      const signer = testAttestationSigner();
      const tampered = await signer.verify(
        {
          agentId: 42n,
          nullifier: NULLIFIER,
          reviewer: REVIEWER,
          expiry: BigInt(NOW + TTL),
          value: 100n, // the reviewer authorized 80
          valueDecimals: 0,
          feedbackHash: FEEDBACK_HASH,
          feedbackURI: FEEDBACK_URI,
          reviewType: REVIEW_TYPE.FREE,
          receiptId: ZERO_BYTES32,
        },
        body.attestation.signature,
      );

      expect(tampered).toBe(false);
    });
  });

  describe('client-supplied review fields are ignored', () => {
    it('uses the stored values, not restated ones', async () => {
      seedChallenge({ value: 80 });
      const signature = await signChallenge(CHALLENGE);

      const body = (await (
        await post(buildApp(), {
          challengeId: CHALLENGE,
          signature,
          // Every one of these must be disregarded.
          value: 100,
          reviewer: getAddress(`0x${'99'.repeat(20)}`),
          nullifier: `0x${'ee'.repeat(32)}`,
          feedbackHash: `0x${'ee'.repeat(32)}`,
          reviewType: REVIEW_TYPE.PAID,
          receiptId: `0x${'ee'.repeat(32)}`,
          agentId: '999',
          expiry: '1',
        })
      ).json()) as AttestBody;

      expect(body.attestation['value']).toBe('80');
      expect(body.attestation['reviewer']).toBe(REVIEWER);
      expect(body.attestation['nullifier']).toBe(NULLIFIER);
      expect(body.attestation['feedbackHash']).toBe(FEEDBACK_HASH);
      expect(body.attestation['reviewType']).toBe(REVIEW_TYPE.FREE);
      expect(body.attestation['receiptId']).toBe(ZERO_BYTES32);
      expect(body.attestation['agentId']).toBe('42');
      expect(body.attestation['expiry']).toBe(String(NOW + TTL));
      expect(body.submit_function).toBe('submitFreeReview');
    });
  });

  describe('ERC-1271 contract wallets', () => {
    const WALLET = getAddress(`0x${'88'.repeat(20)}`);

    it('accepts a wallet that returns the magic value', async () => {
      seedChallenge({ reviewer: WALLET });
      const app = buildApp({ contractWalletReader: fakeReader() });

      const res = await post(app, {
        challengeId: CHALLENGE,
        signature: `0x${'ab'.repeat(96)}`,
      });

      expect(res.status).toBe(200);
      expect(((await res.json()) as AttestBody).attestation['reviewer']).toBe(WALLET);
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBe(NOW);
    });

    it('rejects a wallet that declines', async () => {
      seedChallenge({ reviewer: WALLET });
      const app = buildApp({ contractWalletReader: fakeReader({ magic: '0xffffffff' }) });

      const res = await post(app, {
        challengeId: CHALLENGE,
        signature: `0x${'ab'.repeat(96)}`,
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: 'invalid_wallet_signature',
        reason: 'invalid_contract_signature',
      });
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBeNull();
    });

    it('rejects an address with no bytecode', async () => {
      seedChallenge({ reviewer: WALLET });
      const app = buildApp({ contractWalletReader: fakeReader({ code: '0x' }) });

      const res = await post(app, {
        challengeId: CHALLENGE,
        signature: `0x${'ab'.repeat(96)}`,
      });

      expect(res.status).toBe(400);
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBeNull();
    });

    it('reports an RPC failure as unavailable, not as an invalid signature', async () => {
      seedChallenge({ reviewer: WALLET });
      const app = buildApp({
        contractWalletReader: fakeReader({
          magic: () => {
            throw new Error('fetch failed: https://rpc.example.com/v1/secret-key');
          },
        }),
      });

      const res = await post(app, {
        challengeId: CHALLENGE,
        signature: `0x${'ab'.repeat(96)}`,
      });

      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toBe(JSON.stringify({ error: 'signature_verification_unavailable' }));
      expect(text).not.toContain('secret-key');
      // An outage must leave the challenge spendable.
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBeNull();
    });
  });

  describe('signature failures never consume', () => {
    it('rejects a signature from a different wallet', async () => {
      seedChallenge();
      const signature = await signChallenge(CHALLENGE, OTHER_KEY);

      const res = await post(buildApp(), { challengeId: CHALLENGE, signature });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: 'invalid_wallet_signature',
        reason: 'signer_mismatch',
      });
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBeNull();
    });

    it('rejects a signature over different content', async () => {
      // Signed against a second challenge, presented for the first.
      const other = `0x${'66'.repeat(32)}` as Hex;
      seedChallenge();
      seedChallenge({ nonce: other, value: 10, nullifierDecimal: '8' });
      const signature = await signChallenge(other);

      const res = await post(buildApp(), { challengeId: CHALLENGE, signature });

      expect(res.status).toBe(400);
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBeNull();
    });

    it.each([`0x${'ab'.repeat(65)}`, '0xdeadbeef', '0x'])(
      'rejects the invalid signature %o',
      async (signature) => {
        seedChallenge();

        const res = await post(buildApp(), { challengeId: CHALLENGE, signature });

        expect(res.status).toBe(400);
        expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBeNull();
      },
    );

    it('leaves the verification unauthorized after a failure', async () => {
      seedChallenge();
      const signature = await signChallenge(CHALLENGE, OTHER_KEY);

      await post(buildApp(), { challengeId: CHALLENGE, signature });

      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM world_id_verifications WHERE authorized_at IS NOT NULL',
          )
          .get(),
      ).toEqual({ n: 0 });
    });
  });

  describe('challenge state', () => {
    it('rejects an unknown challenge', async () => {
      const res = await post(buildApp(), {
        challengeId: `0x${'ee'.repeat(32)}`,
        signature: `0x${'ab'.repeat(65)}`,
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'unknown_challenge' });
    });

    it('rejects an expired challenge before verifying anything', async () => {
      seedChallenge({ deadline: NOW - 1 });
      const signature = await signChallenge(CHALLENGE);

      const res = await post(buildApp(), { challengeId: CHALLENGE, signature });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'challenge_expired' });
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBeNull();
    });

    it('rejects at the exact deadline', async () => {
      seedChallenge({ deadline: NOW });
      const signature = await signChallenge(CHALLENGE);

      expect((await post(buildApp(), { challengeId: CHALLENGE, signature })).status).toBe(400);
    });

    it('rejects a different signature on an already-consumed challenge', async () => {
      seedChallenge();
      const app = buildApp();
      expect(
        (await post(app, { challengeId: CHALLENGE, signature: await signChallenge(CHALLENGE) }))
          .status,
      ).toBe(200);

      // A second, different signature cannot re-spend it.
      const res = await post(app, {
        challengeId: CHALLENGE,
        signature: await signChallenge(CHALLENGE, OTHER_KEY),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_wallet_signature' });
    });

    it('re-issues an attestation for an identical retry', async () => {
      // The reviewer signed once; a lost response must not strand them.
      seedChallenge();
      const app = buildApp();
      const signature = await signChallenge(CHALLENGE);

      const first = (await (
        await post(app, { challengeId: CHALLENGE, signature })
      ).json()) as AttestBody;
      const retry = await post(app, { challengeId: CHALLENGE, signature });

      expect(retry.status).toBe(200);
      const second = (await retry.json()) as AttestBody;
      expect(second.attestation).toEqual(first.attestation);
      // Still exactly one consumption.
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBe(NOW);
    });

    it('allows the retry even after the deadline has passed', async () => {
      seedChallenge();
      const signature = await signChallenge(CHALLENGE);
      expect((await post(buildApp(), { challengeId: CHALLENGE, signature })).status).toBe(200);

      const later = createApp(appDeps(db, { now: () => DEADLINE + 1000 }));
      expect((await post(later, { challengeId: CHALLENGE, signature })).status).toBe(200);
    });

    it('refuses a sibling challenge once one is authorized', async () => {
      const sibling = `0x${'66'.repeat(32)}` as Hex;
      seedChallenge();
      const record = findReviewAuthorization(db, CHALLENGE);
      createReviewAuthorization(
        db,
        sibling,
        {
          verificationNonce: record?.verificationNonce as string,
          agentId: '42',
          reviewer: REVIEWER,
          nullifier: NULLIFIER,
          value: 90,
          valueDecimals: 0,
          feedbackHash: FEEDBACK_HASH,
          reviewType: REVIEW_TYPE.FREE,
          receiptId: ZERO_BYTES32,
          deadline: DEADLINE,
        },
        NOW - 5,
      );

      const app = buildApp();
      expect(
        (await post(app, { challengeId: CHALLENGE, signature: await signChallenge(CHALLENGE) }))
          .status,
      ).toBe(200);

      const res = await post(app, {
        challengeId: sibling,
        signature: await signChallenge(sibling),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'verification_already_authorized' });
    });
  });

  describe('expiry is re-evaluated after wallet verification', () => {
    /** A reader that advances the clock while verifying, as a slow RPC would. */
    function advancingReader(advanceTo: () => void): ContractWalletReader {
      return {
        async getBlock() {
          return HEAD;
        },
        async getCode() {
          advanceTo();
          return '0x60806040';
        },
        async isValidSignature() {
          return ERC1271_MAGIC_VALUE as Hex;
        },
      };
    }

    it('rejects a challenge that expires during verification', async () => {
      const wallet = getAddress(`0x${'88'.repeat(20)}`);
      seedChallenge({ reviewer: wallet, deadline: NOW + 10 });

      let clock = NOW;
      const app = createApp(
        appDeps(db, {
          now: () => clock,
          contractWalletReader: advancingReader(() => {
            clock = NOW + 11;
          }),
        }),
      );

      const res = await post(app, {
        challengeId: CHALLENGE,
        signature: `0x${'ab'.repeat(96)}`,
      });

      // The wallet vouched for it, but the window closed first.
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'expired' });
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBeNull();
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM world_id_verifications WHERE authorized_at IS NOT NULL',
          )
          .get(),
      ).toEqual({ n: 0 });
    });

    it('rejects when the clock lands exactly on the deadline', async () => {
      const wallet = getAddress(`0x${'88'.repeat(20)}`);
      seedChallenge({ reviewer: wallet, deadline: NOW + 10 });

      let clock = NOW;
      const app = createApp(
        appDeps(db, {
          now: () => clock,
          contractWalletReader: advancingReader(() => {
            clock = NOW + 10;
          }),
        }),
      );

      expect(
        (await post(app, { challengeId: CHALLENGE, signature: `0x${'ab'.repeat(96)}` })).status,
      ).toBe(400);
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBeNull();
    });

    it('succeeds when the clock advances but stays inside the window', async () => {
      const wallet = getAddress(`0x${'88'.repeat(20)}`);
      seedChallenge({ reviewer: wallet, deadline: NOW + 100 });

      let clock = NOW;
      const app = createApp(
        appDeps(db, {
          now: () => clock,
          contractWalletReader: advancingReader(() => {
            clock = NOW + 5;
          }),
        }),
      );

      const body = (await (
        await post(app, { challengeId: CHALLENGE, signature: `0x${'ab'.repeat(96)}` })
      ).json()) as AttestBody;

      // Consumed and dated from after verification, not before.
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBe(NOW + 5);
      expect(body.attestation['expiry']).toBe(String(NOW + 5 + TTL));
    });
  });

  describe('retry with an advancing clock', () => {
    it('consumes once, repeats the review, and re-dates the expiry', async () => {
      seedChallenge();
      const signature = await signChallenge(CHALLENGE);

      let clock = NOW;
      const app = createApp(appDeps(db, { now: () => clock }));

      const first = (await (
        await post(app, { challengeId: CHALLENGE, signature })
      ).json()) as AttestBody;

      clock = NOW + 120;
      const retry = await post(app, { challengeId: CHALLENGE, signature });
      expect(retry.status).toBe(200);
      const second = (await retry.json()) as AttestBody;

      // Consumed exactly once, at the first call's time.
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBe(NOW);
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM world_id_verifications WHERE authorized_at IS NOT NULL',
          )
          .get(),
      ).toEqual({ n: 1 });

      // Same review, freshly dated.
      const { signature: _s1, expiry: rawFirstExpiry, ...firstFields } = first.attestation;
      const { signature: _s2, expiry: rawSecondExpiry, ...secondFields } = second.attestation;
      const firstExpiry = rawFirstExpiry as string;
      const secondExpiry = rawSecondExpiry as string;
      expect(secondFields).toEqual(firstFields);
      expect(firstExpiry).toBe(String(NOW + TTL));
      expect(secondExpiry).toBe(String(NOW + 120 + TTL));
      expect(second.attestation.signature).not.toBe(first.attestation.signature);

      // Each signature is valid for its own expiry, and only its own.
      const signer = testAttestationSigner();
      const base = {
        agentId: 42n,
        nullifier: NULLIFIER,
        reviewer: REVIEWER,
        value: 80n,
        valueDecimals: 0,
        feedbackHash: FEEDBACK_HASH,
        feedbackURI: FEEDBACK_URI,
        reviewType: REVIEW_TYPE.FREE,
        receiptId: ZERO_BYTES32,
      } as const;

      await expect(
        signer.verify({ ...base, expiry: BigInt(firstExpiry) }, first.attestation.signature),
      ).resolves.toBe(true);
      await expect(
        signer.verify({ ...base, expiry: BigInt(secondExpiry) }, second.attestation.signature),
      ).resolves.toBe(true);
      // Cross-checking proves the expiry is genuinely bound.
      await expect(
        signer.verify({ ...base, expiry: BigInt(secondExpiry) }, first.attestation.signature),
      ).resolves.toBe(false);
    });
  });

  describe('signature size bound', () => {
    const oversized = `0x${'ab'.repeat(MAX_SIGNATURE_BYTES + 1)}` as Hex;

    it('rejects a signature over the limit', async () => {
      seedChallenge();

      const res = await post(buildApp(), { challengeId: CHALLENGE, signature: oversized });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'signature_too_large' });
    });

    it('accepts one exactly at the limit, reaching verification', async () => {
      // At the bound the request proceeds and fails on the signature itself,
      // which shows the limit is not off by one.
      seedChallenge();
      const atLimit = `0x${'ab'.repeat(MAX_SIGNATURE_BYTES)}` as Hex;

      const res = await post(buildApp(), { challengeId: CHALLENGE, signature: atLimit });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_wallet_signature' });
    });

    it('never invokes the wallet verifier', async () => {
      const wallet = getAddress(`0x${'88'.repeat(20)}`);
      seedChallenge({ reviewer: wallet });

      const calls: string[] = [];
      const recording: ContractWalletReader = {
        async getBlock() {
          calls.push('getBlock');
          return HEAD;
        },
        async getCode() {
          calls.push('getCode');
          return '0x60806040';
        },
        async isValidSignature() {
          calls.push('isValidSignature');
          return ERC1271_MAGIC_VALUE as Hex;
        },
      };

      const app = buildApp({ contractWalletReader: recording });
      await post(app, { challengeId: CHALLENGE, signature: oversized });

      expect(calls).toEqual([]);
    });

    it('never consumes the challenge', async () => {
      seedChallenge();

      await post(buildApp(), { challengeId: CHALLENGE, signature: oversized });

      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBeNull();
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM world_id_verifications WHERE authorized_at IS NOT NULL',
          )
          .get(),
      ).toEqual({ n: 0 });
    });

    it('allows a multi-owner contract-wallet signature', async () => {
      // Roughly sixty 65-byte owner signatures must still fit.
      const wallet = getAddress(`0x${'88'.repeat(20)}`);
      seedChallenge({ reviewer: wallet });
      const safeStyle = `0x${'ab'.repeat(65 * 60)}` as Hex;

      expect((65 * 60) / 1).toBeLessThanOrEqual(MAX_SIGNATURE_BYTES);
      const res = await post(buildApp({ contractWalletReader: fakeReader() }), {
        challengeId: CHALLENGE,
        signature: safeStyle,
      });

      expect(res.status).toBe(200);
    });
  });

  describe('concurrent attempts on one challenge', () => {
    it('consumes once and authorizes once', async () => {
      seedChallenge();
      const app = buildApp();
      const signature = await signChallenge(CHALLENGE);

      // better-sqlite3 is synchronous, so these serialize; the assertion is
      // that repetition cannot double-spend. True OS-thread contention on the
      // repository is covered in concurrency.test.ts.
      const results = await Promise.all(
        Array.from({ length: 6 }, () => post(app, { challengeId: CHALLENGE, signature })),
      );

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBe(NOW);
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM world_id_verifications WHERE authorized_at IS NOT NULL',
          )
          .get(),
      ).toEqual({ n: 1 });
    });

    it('lets only one of several different signatures win', async () => {
      seedChallenge();
      const app = buildApp();

      const good = await post(app, {
        challengeId: CHALLENGE,
        signature: await signChallenge(CHALLENGE),
      });
      const other = await post(app, {
        challengeId: CHALLENGE,
        signature: await signChallenge(CHALLENGE, OTHER_KEY),
      });

      expect(good.status).toBe(200);
      expect(other.status).toBe(400);
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
      ['a missing challengeId', { signature: `0x${'ab'.repeat(65)}` }, 'invalid_challenge_id'],
      [
        'a malformed challengeId',
        { challengeId: '0xbeef', signature: `0x${'ab'.repeat(65)}` },
        'invalid_challenge_id',
      ],
      ['a missing signature', { challengeId: CHALLENGE }, 'invalid_signature_format'],
      [
        'a non-hex signature',
        { challengeId: CHALLENGE, signature: 'not-hex' },
        'invalid_signature_format',
      ],
      [
        'an odd-length signature',
        { challengeId: CHALLENGE, signature: '0xabc' },
        'invalid_signature_format',
      ],
    ])('rejects %s', async (_label, body, error) => {
      seedChallenge();

      const res = await post(buildApp(), body);

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error });
    });

    it('rejects GET', async () => {
      expect((await buildApp().request(ENDPOINT)).status).toBe(404);
    });
  });

  describe('confidentiality', () => {
    it('never returns the Record Server key', async () => {
      seedChallenge();
      const signature = await signChallenge(CHALLENGE);

      const text = await (await post(buildApp(), { challengeId: CHALLENGE, signature })).text();

      expect(text).not.toContain(VALID_ENV.RECORD_SERVER_PRIVATE_KEY);
      expect(text).not.toContain(VALID_ENV.RECORD_SERVER_PRIVATE_KEY.slice(2));
      expect(text).not.toContain(VALID_ENV.WORLD_SIGNING_KEY);
      expect(text).not.toContain(VALID_ENV.RPC_URL);
    });

    it('redacts a signing failure', async () => {
      seedChallenge();
      const signature = await signChallenge(CHALLENGE);
      const failing = {
        ...testAttestationSigner(),
        async sign() {
          throw new Error('key material 0xdeadbeefcafe leaked here');
        },
      };

      const res = await post(buildApp({ attestationSigner: failing }), {
        challengeId: CHALLENGE,
        signature,
      });

      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe(JSON.stringify({ error: 'attestation_signing_failed' }));
      expect(text).not.toContain('0xdeadbeefcafe');
    });

    it('never claims the review was submitted', async () => {
      seedChallenge();
      const signature = await signChallenge(CHALLENGE);

      const body = (await (
        await post(buildApp(), { challengeId: CHALLENGE, signature })
      ).json()) as AttestBody;

      expect(body.submitted).toBe(false);
    });

    it('logs nothing on the success path', async () => {
      seedChallenge();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const signature = await signChallenge(CHALLENGE);

      await post(buildApp(), { challengeId: CHALLENGE, signature });

      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe('domain binding', () => {
    it('rejects a signature made for another chain', async () => {
      seedChallenge();
      const record = findReviewAuthorization(db, CHALLENGE);
      const wrongChain = authorizationTypedData(
        {
          agentId: BigInt(record?.agentId as string),
          nullifier: NULLIFIER,
          reviewer: REVIEWER,
          value: 80n,
          valueDecimals: 0,
          feedbackHash: FEEDBACK_HASH,
          reviewType: REVIEW_TYPE.FREE,
          receiptId: ZERO_BYTES32,
          nonce: CHALLENGE,
          deadline: BigInt(DEADLINE),
        },
        1,
        GATEWAY,
      );
      const signature = await privateKeyToAccount(REVIEWER_KEY).signTypedData({
        domain: wrongChain.domain,
        types: wrongChain.types,
        primaryType: wrongChain.primaryType,
        message: wrongChain.message,
      });

      const res = await post(buildApp(), { challengeId: CHALLENGE, signature });

      expect(res.status).toBe(400);
      expect(findReviewAuthorization(db, CHALLENGE)?.consumedAt).toBeNull();
    });

    it('signs the attestation under the gateway domain', async () => {
      seedChallenge();
      const signature = await signChallenge(CHALLENGE);
      const body = (await (
        await post(buildApp(), { challengeId: CHALLENGE, signature })
      ).json()) as AttestBody;

      // A signer bound to a different chain must not verify it.
      const otherChain = createAttestationSigner({
        privateKey: VALID_ENV.RECORD_SERVER_PRIVATE_KEY,
        chainId: 1,
        reviewGatewayAddress: GATEWAY,
      });

      await expect(
        otherChain.verify(
          {
            agentId: 42n,
            nullifier: NULLIFIER,
            reviewer: REVIEWER,
            expiry: BigInt(NOW + TTL),
            value: 80n,
            valueDecimals: 0,
            feedbackHash: FEEDBACK_HASH,
            feedbackURI: FEEDBACK_URI,
            reviewType: REVIEW_TYPE.FREE,
            receiptId: ZERO_BYTES32,
          },
          body.attestation.signature,
        ),
      ).resolves.toBe(false);
    });
  });
});

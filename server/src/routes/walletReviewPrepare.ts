import { Hono } from 'hono';
import { getAddress, isAddress, keccak256, toBytes } from 'viem';
import type { Address, Hex } from 'viem';
import type { Repository } from '../db/repository.js';
import { generateAuthorizationNonce } from '../db/reviewAuthorizations.js';
import { WalletAlreadyReviewedError } from '../db/walletReviewAuthorizations.js';
import { InvalidAgentIdError, parseAgentId } from '../worldid/action.js';
import {
  AuthorizationValidationError,
  authorizationTypedData,
} from '../signing/reviewAuthorization.js';
import type { ReviewAuthorization } from '../signing/reviewAuthorization.js';
import { REVIEW_TYPE, ZERO_BYTES32, walletNullifier } from '../signing/reviewContent.js';
import { DEFAULT_AUTHORIZATION_TTL_SECONDS, MAX_CONTENT_BYTES } from './reviewPrepare.js';
import { serializeTypedData } from './reviewPrepare.js';
import type { SerializedTypedData } from './reviewPrepare.js';

export interface WalletReviewPrepareDeps {
  readonly repo: Repository;
  readonly chainId: number;
  readonly reviewGatewayAddress: Address;
  /** `WALLET_REVIEWS_ENABLED`. */
  readonly enabled: boolean;
  /** Injectable clock, Unix seconds. */
  readonly now?: () => number;
  /** How long the reviewer has to sign. */
  readonly deadlineSeconds?: number;
}

export interface WalletReviewPrepareResponse {
  readonly challenge_id: Hex;
  readonly deadline: number;
  /** Computed by the server from `content`, never supplied. */
  readonly feedback_hash: Hex;
  readonly typed_data: SerializedTypedData;
  /** Always 2. */
  readonly review_type: 2;
  /** Always `wallet_only`: an address authorized this; no personhood is claimed. */
  readonly verification: 'wallet_only';
}

/**
 * The only fields a request may carry. Anything else — `reviewType`,
 * `receiptId`, `nullifier`, `requestNonce`, or a typo — is refused rather than
 * ignored: a field the server silently drops is a field a caller believes it
 * set. The four named in the spec are the ones that would otherwise let a
 * caller choose its own assurance level, nullifier or World ID binding.
 */
const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'agentId',
  'reviewer',
  'value',
  'valueDecimals',
  'content',
]);

/**
 * `GET /api/reviews/wallet/status` and `POST /api/reviews/wallet/prepare`.
 *
 * Prepare is the wallet-only counterpart of `/api/reviews/prepare`. There is no
 * World ID proof to bind to, so the server derives everything the proof would
 * have supplied: `reviewType` is 2, `receiptId` is zero, and the nullifier is
 * `walletNullifier(reviewer)` — the value the gateway recomputes and demands.
 * `feedbackHash` is computed from the submitted content. The chain and gateway
 * are bound through the EIP-712 domain, and agent, reviewer, value, hash,
 * nonce and deadline through the signed message, so a signature cannot be moved
 * to another agent, chain or deployment.
 *
 * Nothing is signed by the server and nothing is spent here. A wallet that
 * already has a spent review for the agent is refused up front.
 */
export function walletReviewPrepareRoute(deps: WalletReviewPrepareDeps): Hono {
  const app = new Hono();
  const clock = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const ttl = deps.deadlineSeconds ?? DEFAULT_AUTHORIZATION_TTL_SECONDS;

  // Always 200: it reports the flag, it does not depend on it.
  app.get('/api/reviews/wallet/status', (c) => c.json({ enabled: deps.enabled }, 200));

  app.post('/api/reviews/wallet/prepare', async (c) => {
    if (!deps.enabled) {
      return c.json({ error: 'wallet_reviews_disabled' }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'invalid_request', message: 'body must be a JSON object' }, 400);
    }
    const input = body as Record<string, unknown>;

    const unknown = Object.keys(input).filter((key) => !ALLOWED_FIELDS.has(key));
    if (unknown.length > 0) {
      // Names only, never values: a rejected field can hold anything.
      return c.json({ error: 'unknown_fields', fields: unknown.sort() }, 400);
    }

    // agentId is a string on this endpoint (a uint256 does not fit a JSON
    // number), unlike the free path which also tolerates a number.
    if (typeof input['agentId'] !== 'string') {
      return c.json(
        { error: 'invalid_agent_id', message: 'agentId must be a decimal string' },
        400,
      );
    }
    let agentId: bigint;
    try {
      agentId = parseAgentId(input['agentId']);
    } catch (err) {
      if (err instanceof InvalidAgentIdError) {
        return c.json({ error: 'invalid_agent_id', message: err.message }, 400);
      }
      throw err;
    }

    const rawReviewer = input['reviewer'];
    if (typeof rawReviewer !== 'string' || !isAddress(rawReviewer, { strict: false })) {
      return c.json({ error: 'invalid_reviewer', message: 'reviewer must be an address' }, 400);
    }
    const reviewer = getAddress(rawReviewer);

    const value = input['value'];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return c.json({ error: 'invalid_value', message: 'value must be an integer' }, 400);
    }
    const valueDecimals = input['valueDecimals'];
    if (typeof valueDecimals !== 'number' || !Number.isInteger(valueDecimals)) {
      return c.json(
        { error: 'invalid_value_decimals', message: 'valueDecimals must be an integer' },
        400,
      );
    }

    const content = input['content'];
    if (typeof content !== 'string' || content.length === 0) {
      return c.json(
        { error: 'invalid_content', message: 'content must be a non-empty string' },
        400,
      );
    }
    const contentBytes = toBytes(content);
    if (contentBytes.length > MAX_CONTENT_BYTES) {
      return c.json(
        {
          error: 'content_too_large',
          message: `content must be at most ${MAX_CONTENT_BYTES} bytes`,
        },
        400,
      );
    }
    const feedbackHash = keccak256(contentBytes);

    const nonce = generateAuthorizationNonce();
    const now = clock();
    const deadline = now + ttl;

    const authorization: ReviewAuthorization = {
      agentId,
      nullifier: walletNullifier(reviewer),
      reviewer,
      value: BigInt(value),
      valueDecimals,
      feedbackHash,
      reviewType: REVIEW_TYPE.WALLET,
      receiptId: ZERO_BYTES32,
      nonce,
      deadline: BigInt(deadline),
    };

    // Validates through the shared review-content rules; a challenge is never
    // issued for content the gateway would refuse.
    let typedData;
    try {
      typedData = authorizationTypedData(authorization, deps.chainId, deps.reviewGatewayAddress);
    } catch (err) {
      if (err instanceof AuthorizationValidationError) {
        return c.json({ error: 'invalid_review_content', issues: err.issues }, 400);
      }
      throw err;
    }

    // Duplicate wallet/agent: declined here, before any content is stored.
    // The authoritative check is inside createWalletReviewAuthorization.
    if (await deps.repo.isWalletReviewed(agentId.toString(10), reviewer)) {
      return c.json({ error: 'wallet_already_reviewed' }, 409);
    }

    // The attestation's feedbackURI is derived from this hash, so the text has
    // to be retrievable from the moment that URI can be signed. Idempotent.
    try {
      await deps.repo.putReviewContent({ content: contentBytes, createdAt: now });
    } catch {
      return c.json({ error: 'storage_error' }, 500);
    }

    try {
      await deps.repo.createWalletReviewAuthorization(
        nonce,
        {
          agentId: agentId.toString(10),
          reviewer,
          nullifier: authorization.nullifier,
          value,
          valueDecimals,
          feedbackHash,
          reviewType: REVIEW_TYPE.WALLET,
          receiptId: ZERO_BYTES32,
          deadline,
        },
        now,
      );
    } catch (err) {
      if (err instanceof WalletAlreadyReviewedError) {
        return c.json({ error: 'wallet_already_reviewed' }, 409);
      }
      // Opaque: a storage fault's detail would describe the schema.
      return c.json({ error: 'challenge_not_persisted' }, 500);
    }

    const response: WalletReviewPrepareResponse = {
      challenge_id: nonce,
      deadline,
      feedback_hash: feedbackHash,
      typed_data: serializeTypedData(typedData),
      review_type: REVIEW_TYPE.WALLET,
      verification: 'wallet_only',
    };
    return c.json(response, 200);
  });

  return app;
}

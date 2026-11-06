import { Hono } from 'hono';
import { getAddress, isAddress, keccak256, toBytes } from 'viem';
import type { Address, Hex } from 'viem';
import type { Repository } from '../db/repository.js';
// Not data access: `AuthorizationBindingError` is the class the catch below
// tests with `instanceof`, and `generateAuthorizationNonce` is pure crypto.
// Every query goes through `deps.repo`.
import {
  AuthorizationBindingError,
  generateAuthorizationNonce,
} from '../db/reviewAuthorizations.js';
import { InvalidAgentIdError, parseAgentId } from '../worldid/action.js';
import {
  AuthorizationValidationError,
  authorizationTypedData,
} from '../signing/reviewAuthorization.js';
import type { ReviewAuthorization } from '../signing/reviewAuthorization.js';
import {
  InvalidNullifierError,
  ZERO_BYTES32,
  REVIEW_TYPE,
  nullifierToBytes32,
} from '../signing/reviewContent.js';

export interface ReviewPrepareDeps {
  readonly repo: Repository;
  readonly chainId: number;
  readonly reviewGatewayAddress: Address;
  /** Injectable clock, Unix seconds. */
  readonly now?: () => number;
  /** How long the reviewer has to sign. */
  readonly deadlineSeconds?: number;
}

/** Default signing window, matching the RP request's lifetime. */
export const DEFAULT_AUTHORIZATION_TTL_SECONDS = 300;

/** Upper bound on review text, so a caller cannot make the server hash megabytes. */
export const MAX_CONTENT_BYTES = 16_384;

const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** EIP-712 typed data with every integer rendered as a decimal string. */
export interface SerializedTypedData {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

export interface ReviewPrepareResponse {
  /** The challenge nonce; identifies this authorization when it is submitted. */
  readonly challenge_id: Hex;
  readonly deadline: number;
  /** Computed by the server from the submitted content, never supplied. */
  readonly feedback_hash: Hex;
  readonly typed_data: SerializedTypedData;
}

/**
 * JSON cannot carry a bigint, and a wallet expects uint/int fields as decimal
 * strings, so every bigint is rendered that way. The values are unchanged —
 * EIP-712 encodes them as integers either way — so the digest the wallet
 * computes is the one the server will verify.
 */
export function serializeTypedData(
  data: ReturnType<typeof authorizationTypedData>,
): SerializedTypedData {
  const message: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data.message)) {
    message[key] = typeof value === 'bigint' ? value.toString(10) : value;
  }

  const domain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data.domain)) {
    domain[key] = typeof value === 'bigint' ? value.toString(10) : value;
  }

  return {
    domain,
    types: data.types as unknown as SerializedTypedData['types'],
    primaryType: data.primaryType,
    message,
  };
}

/**
 * `POST /api/reviews/prepare` — turn a verified proof plus review content into
 * typed data for the reviewer's wallet to sign.
 *
 * The caller names the World ID request it completed, and that exact
 * verification's stored nullifier is what goes into the authorization. Neither
 * the nullifier nor the choice of verification is left to the client: either
 * would let a caller attach someone else's personhood to their own review.
 *
 * `feedbackHash` is likewise computed here from the submitted content rather
 * than accepted, so the hash the reviewer signs provably covers the text the
 * server was given.
 *
 * Nothing is consumed and nothing is signed by the server. This only creates a
 * challenge; spending it is the next endpoint's job.
 */
export function reviewPrepareRoute(deps: ReviewPrepareDeps): Hono {
  const app = new Hono();
  const clock = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const ttl = deps.deadlineSeconds ?? DEFAULT_AUTHORIZATION_TTL_SECONDS;

  app.post('/api/reviews/prepare', async (c) => {
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

    // Small, bounded integers: a JSON number carries them exactly, unlike
    // agentId, which can exceed what a double represents.
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
    const reviewType = input['reviewType'];
    if (typeof reviewType !== 'number' || !Number.isInteger(reviewType)) {
      return c.json(
        { error: 'invalid_review_type', message: 'reviewType must be an integer' },
        400,
      );
    }

    // A wallet review has no World ID verification to bind to, so it has its
    // own endpoint and its own table. Refused here rather than left to the
    // shared validator so the reason is explicit.
    if (reviewType === REVIEW_TYPE.WALLET) {
      return c.json(
        {
          error: 'invalid_review_content',
          issues: [
            {
              field: 'reviewType',
              message: 'wallet reviews are prepared at /api/reviews/wallet/prepare',
            },
          ],
        },
        400,
      );
    }

    // Omitted means the free path; the shared validator enforces the pairing
    // with reviewType rather than this route second-guessing it.
    const rawReceiptId = input['receiptId'] ?? ZERO_BYTES32;
    if (typeof rawReceiptId !== 'string' || !BYTES32_PATTERN.test(rawReceiptId)) {
      return c.json(
        {
          error: 'invalid_receipt_id',
          message: 'receiptId must be a 0x-prefixed 32-byte hex string',
        },
        400,
      );
    }
    const receiptId = rawReceiptId.toLowerCase() as Hex;

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

    // The caller names the exact World ID request it completed — the
    // `rp_context.nonce` it was issued. Selecting a verification by agent and
    // wallet alone would be ambiguous when one wallet holds more than one
    // proof, and could attach the wrong human's personhood to this review.
    const rawRequestNonce = input['requestNonce'];
    if (typeof rawRequestNonce !== 'string' || !BYTES32_PATTERN.test(rawRequestNonce)) {
      return c.json(
        {
          error: 'invalid_request_nonce',
          message: 'requestNonce must be a 0x-prefixed 32-byte hex string',
        },
        400,
      );
    }

    const verification = await deps.repo.findVerificationByNonce(rawRequestNonce);
    if (verification === undefined) {
      return c.json({ error: 'unknown_verification' }, 404);
    }
    if (verification.agentId !== agentId.toString(10)) {
      return c.json({ error: 'verification_agent_mismatch' }, 400);
    }
    if (getAddress(verification.reviewer) !== reviewer) {
      return c.json({ error: 'verification_reviewer_mismatch' }, 400);
    }
    // Also enforced inside createReviewAuthorization's transaction, which is
    // the authoritative check; this one declines earlier and more precisely.
    if (await deps.repo.isVerificationAuthorized(verification.nonce)) {
      return c.json({ error: 'verification_already_authorized' }, 409);
    }

    // The nullifier comes from that stored verification, converted once.
    let nullifier: Hex;
    try {
      nullifier = nullifierToBytes32(verification.nullifier);
    } catch (err) {
      if (err instanceof InvalidNullifierError) {
        // A stored nullifier that will not convert is a server-side fault; its
        // value is not echoed.
        return c.json({ error: 'verification_unusable' }, 500);
      }
      throw err;
    }

    const nonce = generateAuthorizationNonce();
    const now = clock();
    const deadline = now + ttl;

    const authorization: ReviewAuthorization = {
      agentId,
      nullifier,
      reviewer,
      value: BigInt(value),
      valueDecimals,
      feedbackHash,
      reviewType,
      receiptId,
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

    // Persist the content under its own hash before issuing the challenge. The
    // attestation will carry a feedbackURI derived from this hash, so the text
    // has to be retrievable from the moment that URI can be signed. Writing is
    // idempotent: a reviewer redrafting to the same words reuses the row.
    try {
      await deps.repo.putReviewContent({ content: contentBytes, createdAt: now });
    } catch {
      // Opaque: a storage fault's detail would describe the schema.
      return c.json({ error: 'storage_error' }, 500);
    }

    try {
      await deps.repo.createReviewAuthorization(
        nonce,
        {
          verificationNonce: verification.nonce,
          agentId: agentId.toString(10),
          reviewer,
          nullifier,
          value,
          valueDecimals,
          feedbackHash,
          reviewType,
          receiptId,
          deadline,
        },
        now,
      );
    } catch (err) {
      if (err instanceof AuthorizationBindingError) {
        return c.json(
          { error: err.reason },
          err.reason === 'verification_already_authorized' ? 409 : 400,
        );
      }
      // Opaque: a storage fault's detail would describe the schema.
      return c.json({ error: 'challenge_not_persisted' }, 500);
    }

    const response: ReviewPrepareResponse = {
      challenge_id: nonce,
      deadline,
      feedback_hash: feedbackHash,
      typed_data: serializeTypedData(typedData),
    };

    return c.json(response, 200);
  });

  return app;
}

import { Hono } from 'hono';
import { getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import type { Repository } from '../db/repository.js';
import type { ReviewAuthorizationRecord } from '../db/reviewAuthorizations.js';
import type { WalletReviewAuthorizationRecord } from '../db/walletReviewAuthorizations.js';
import { authorizationTypedData } from '../signing/reviewAuthorization.js';
import { REVIEW_TYPE } from '../signing/reviewContent.js';
import type { Attestation } from '../signing/attestation.js';
import { feedbackUriFor } from '../signing/feedbackUri.js';
import type { AttestationSigner } from '../signing/signer.js';
import { verifyWalletSignature } from '../signing/walletSignature.js';
import type { ContractWalletReader } from '../signing/walletSignature.js';

export interface ReviewAttestDeps {
  readonly repo: Repository;
  readonly chainId: number;
  readonly reviewGatewayAddress: Address;
  /** Base URL the signed evidence URI is derived from. */
  readonly reviewContentBaseUrl: string;
  /** Signs the gateway attestation. Separate from wallet verification. */
  readonly attestationSigner: AttestationSigner;
  /** Omit to verify EOA wallet signatures only, with no chain access. */
  readonly contractWalletReader?: ContractWalletReader;
  /** Injectable clock, Unix seconds. */
  readonly now?: () => number;
  /** How long the gateway attestation stays valid. */
  readonly attestationTtlSeconds?: number;
  /**
   * `WALLET_REVIEWS_ENABLED`. Omitted means false: a wallet challenge is then
   * refused with 503 and never attested, even if one was issued while the
   * feature was on.
   */
  readonly walletReviewsEnabled?: boolean;
}

/**
 * Attestation lifetime.
 *
 * Longer than the signing challenge, because the reviewer still has to send a
 * transaction and have it mined after this is issued.
 */
export const DEFAULT_ATTESTATION_TTL_SECONDS = 3_600;

const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]+$/;

/**
 * Largest wallet signature accepted, in bytes.
 *
 * An EOA signature is 65 bytes, but ERC-1271 signatures are variable: a
 * multi-owner Safe concatenates roughly 65 bytes per owner, and some smart
 * accounts append proofs. 4 KiB covers around sixty owners while still bounding
 * what an unauthenticated caller can make the server hash and forward to an RPC
 * as calldata.
 */
export const MAX_SIGNATURE_BYTES = 4_096;

/** The gateway call this attestation is for. */
export type SubmitFunction = 'submitFreeReview' | 'submitPaidReview' | 'submitWalletReview';

/**
 * The gateway entry point for a stored review type.
 *
 * An explicit table, not a ternary with a default: the previous
 * `PAID ? paid : free` would have sent any new type to `submitFreeReview`, an
 * attestation the gateway rejects at best. Unknown types return undefined and
 * the caller fails closed.
 */
export function submitFunctionFor(reviewType: number): SubmitFunction | undefined {
  switch (reviewType) {
    case REVIEW_TYPE.FREE:
      return 'submitFreeReview';
    case REVIEW_TYPE.PAID:
      return 'submitPaidReview';
    case REVIEW_TYPE.WALLET:
      return 'submitWalletReview';
    default:
      return undefined;
  }
}

/** The stored fields both challenge tables share. */
type StoredChallenge = ReviewAuthorizationRecord | WalletReviewAuthorizationRecord;

/** The attestation, with integers as decimal strings for JSON. */
export interface SerializedAttestation {
  readonly agentId: string;
  readonly nullifier: Hex;
  readonly reviewer: Address;
  readonly expiry: string;
  readonly value: string;
  readonly valueDecimals: number;
  readonly feedbackHash: Hex;
  readonly feedbackURI: string;
  readonly reviewType: number;
  readonly receiptId: Hex;
  /** The Record Server's EIP-712 signature over the ten fields above. */
  readonly signature: Hex;
}

export interface ReviewAttestResponse {
  readonly attestation: SerializedAttestation;
  readonly gateway: Address;
  readonly submit_function: SubmitFunction;
  /**
   * Always false. This endpoint signs an attestation; it does not send a
   * transaction, and holding one is not evidence that a review exists on-chain.
   */
  readonly submitted: false;
}

/** Rebuild the authorization the wallet was asked to sign, from storage. */
function storedAuthorization(record: StoredChallenge) {
  return {
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
  };
}

function serializeAttestation(attestation: Attestation, signature: Hex): SerializedAttestation {
  return {
    agentId: attestation.agentId.toString(10),
    nullifier: attestation.nullifier,
    reviewer: attestation.reviewer,
    expiry: attestation.expiry.toString(10),
    value: attestation.value.toString(10),
    valueDecimals: attestation.valueDecimals,
    feedbackHash: attestation.feedbackHash,
    feedbackURI: attestation.feedbackURI,
    reviewType: attestation.reviewType,
    receiptId: attestation.receiptId,
    signature,
  };
}

/**
 * `POST /api/reviews/attest` — exchange a signed challenge for a gateway
 * attestation.
 *
 * Every review field comes from the stored challenge. The request carries only
 * a challenge id and a signature: there is no field a caller could restate, so
 * none can be restated differently from what the wallet signed.
 *
 * Order is load-bearing. The signature is verified first, against typed data
 * rebuilt from storage; only then is the challenge consumed; only then is the
 * attestation signed. A rejected or unverifiable signature therefore leaves the
 * challenge spendable, and the Record Server's key is never applied to anything
 * the reviewer has not demonstrably authorized.
 */
export function reviewAttestRoute(deps: ReviewAttestDeps): Hono {
  const app = new Hono();
  const clock = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const ttl = deps.attestationTtlSeconds ?? DEFAULT_ATTESTATION_TTL_SECONDS;

  app.post('/api/reviews/attest', async (c) => {
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

    const challengeId = input['challengeId'];
    if (typeof challengeId !== 'string' || !BYTES32_PATTERN.test(challengeId)) {
      return c.json(
        {
          error: 'invalid_challenge_id',
          message: 'challengeId must be a 0x-prefixed 32-byte hex string',
        },
        400,
      );
    }

    const signature = input['signature'];
    if (
      typeof signature !== 'string' ||
      !SIGNATURE_PATTERN.test(signature) ||
      signature.length % 2 !== 0
    ) {
      return c.json(
        {
          error: 'invalid_signature_format',
          message: 'signature must be a 0x-prefixed hex string',
        },
        400,
      );
    }
    if ((signature.length - 2) / 2 > MAX_SIGNATURE_BYTES) {
      // Rejected before any hashing, chain read, or storage access.
      return c.json(
        {
          error: 'signature_too_large',
          message: `signature must be at most ${MAX_SIGNATURE_BYTES} bytes`,
        },
        400,
      );
    }

    // World ID challenges and wallet challenges live in separate tables, and
    // their ids are independent 256-bit random values. The World ID table is
    // consulted first; the wallet table only when it has no such id.
    const worldRecord = await deps.repo.findReviewAuthorization(challengeId);
    const walletRecord =
      worldRecord === undefined
        ? await deps.repo.findWalletReviewAuthorization(challengeId)
        : undefined;
    const record: StoredChallenge | undefined = worldRecord ?? walletRecord;
    if (record === undefined) {
      return c.json({ error: 'unknown_challenge' }, 404);
    }
    const isWalletChallenge = walletRecord !== undefined;

    // The review type is read from storage, never from the request, and must
    // agree with the table it came from: a wallet type in the World ID table
    // (or the reverse) would pair an attestation with the wrong assurance, so
    // it fails closed. An unknown type has no entry point at all.
    const submitFunction = submitFunctionFor(record.reviewType);
    if (
      submitFunction === undefined ||
      isWalletChallenge !== (record.reviewType === REVIEW_TYPE.WALLET)
    ) {
      return c.json({ error: 'unsupported_review_type' }, 500);
    }

    if (isWalletChallenge && deps.walletReviewsEnabled !== true) {
      return c.json({ error: 'wallet_reviews_disabled' }, 503);
    }

    // An unspent challenge past its deadline is refused before any signature
    // work. A spent one is left to the consume below, which answers an
    // identical retry from the original result even after the deadline.
    if (record.consumedAt === null && record.deadline <= clock()) {
      return c.json({ error: 'challenge_expired' }, 400);
    }

    // Rebuilt from storage, never from the request.
    const typedData = authorizationTypedData(
      storedAuthorization(record),
      deps.chainId,
      deps.reviewGatewayAddress,
    );

    const verification = await verifyWalletSignature({
      expectedReviewer: getAddress(record.reviewer),
      typedData,
      signature: signature as Hex,
      ...(deps.contractWalletReader === undefined ? {} : { reader: deps.contractWalletReader }),
    });

    if (!verification.ok) {
      // `verification_unavailable` is a chain outage, not a verdict, so it is
      // reported separately and the challenge stays spendable either way.
      return verification.reason === 'verification_unavailable'
        ? c.json({ error: 'signature_verification_unavailable' }, 503)
        : c.json({ error: 'invalid_wallet_signature', reason: verification.reason }, 400);
    }

    // Read the clock again rather than reusing the pre-check's value. Wallet
    // verification can be a network round trip for a contract wallet, and a
    // challenge can expire while it is in flight; consuming against the earlier
    // reading would spend one that is already dead. This is also the attestation's
    // basis, so its validity window starts when the signature was accepted.
    const now = clock();

    if (isWalletChallenge) {
      const spent = await deps.repo.consumeWalletReviewAuthorization({
        nonce: record.nonce,
        signature: signature as Hex,
        now,
      });
      if (!spent.ok) {
        switch (spent.reason) {
          case 'unknown_challenge':
            return c.json({ error: 'unknown_challenge' }, 404);
          case 'expired':
            return c.json({ error: 'challenge_expired' }, 400);
          case 'signature_conflict':
            return c.json({ error: 'nonce_consumed' }, 409);
          case 'wallet_already_reviewed':
            return c.json({ error: 'wallet_already_reviewed' }, 409);
        }
      }
    } else {
      const consumed = await deps.repo.consumeReviewAuthorization({
        nonce: record.nonce,
        signature: signature as Hex,
        now,
      });

      if (!consumed.ok) {
        const status = consumed.reason === 'expired' ? 400 : 409;
        return c.json({ error: consumed.reason }, status);
      }
    }

    // Signed only now, over values that came from storage and were just proven
    // to carry the reviewer's signature.
    const attestation: Attestation = {
      agentId: BigInt(record.agentId),
      nullifier: record.nullifier,
      reviewer: getAddress(record.reviewer),
      expiry: BigInt(now + ttl),
      value: BigInt(record.value),
      valueDecimals: record.valueDecimals,
      feedbackHash: record.feedbackHash,
      // Derived, never supplied: a pure function of the feedbackHash the
      // reviewer's wallet already signed, so no party to the submission can
      // point the published review at different content.
      feedbackURI: feedbackUriFor(deps.reviewContentBaseUrl, record.feedbackHash),
      reviewType: record.reviewType,
      receiptId: record.receiptId,
    };

    let attestationSignature: Hex;
    try {
      attestationSignature = await deps.attestationSigner.sign(attestation);
    } catch {
      // The challenge is already spent; re-signing is what a retry gets. The
      // underlying error can describe key material, so none of it is relayed.
      return c.json({ error: 'attestation_signing_failed' }, 500);
    }

    const response: ReviewAttestResponse = {
      attestation: serializeAttestation(attestation, attestationSignature),
      gateway: deps.reviewGatewayAddress,
      submit_function: submitFunction,
      submitted: false,
    };

    return c.json(response, 200);
  });

  return app;
}

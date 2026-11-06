import { Hono } from 'hono';
import { getAddress, isAddress } from 'viem';
import type { Repository } from '../db/repository.js';
import { InvalidAgentIdError, parseAgentId, reviewAgentAction } from '../worldid/action.js';
import {
  InvalidProofPayloadError,
  PROOF_OF_HUMAN_IDENTIFIER,
  findProofOfHuman,
  isBoundToReviewer,
  normalizeNullifier,
  parseIDKitResult,
} from '../worldid/proof.js';
import { findVerifiedResult } from '../worldid/verifyClient.js';
import type { WorldIdVerifier } from '../worldid/verifyClient.js';

export interface ReviewProofDeps {
  readonly repo: Repository;
  readonly rpId: string;
  /** The environment proofs must be produced in. */
  readonly environment: string;
  readonly verifier: WorldIdVerifier;
  /** Injectable clock, Unix seconds. */
  readonly now?: () => number;
}

/** What a verified proof yields: the inputs the wallet authorization needs. */
export interface ReviewProofResponse {
  readonly agent_id: string;
  readonly reviewer: string;
  readonly nullifier: string;
  readonly verified_at: number;
}

/** Local failures mapped to a stable code and status. */
const CONSUME_FAILURES: Record<string, { status: 400 | 409; error: string }> = {
  unknown_nonce: { status: 400, error: 'unknown_request' },
  already_consumed: { status: 409, error: 'request_already_used' },
  expired: { status: 400, error: 'request_expired' },
  context_mismatch: { status: 400, error: 'request_context_mismatch' },
  already_reviewed: { status: 409, error: 'already_reviewed' },
};

/**
 * `POST /api/reviews/verify` — check a World ID proof and record the result.
 *
 * Order matters and is deliberate. Everything checkable locally runs before the
 * proof is forwarded — payload shape, action, environment, credential, signal
 * binding, and whether the RP request is still usable — so a doomed submission
 * costs no external call. The request is spent only after the Portal has
 * verified the proof, so a rejected or unreachable verification leaves the nonce
 * reusable.
 *
 * The nullifier written is the one the API returned, never the one the client
 * sent: a client-supplied nullifier is a claim, not evidence.
 */
export function reviewProofRoute(deps: ReviewProofDeps): Hono {
  const app = new Hono();
  const clock = deps.now ?? (() => Math.floor(Date.now() / 1000));

  app.post('/api/reviews/verify', async (c) => {
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

    let result;
    try {
      result = parseIDKitResult(input['proof']);
    } catch (err) {
      if (err instanceof InvalidProofPayloadError) {
        return c.json({ error: 'invalid_proof_payload', message: err.message }, 400);
      }
      throw err;
    }

    // The action is derived from the agent, never read from the proof, then
    // compared: a proof carrying a different action was scoped to a different
    // nullifier and is not evidence about this agent.
    const action = reviewAgentAction(agentId);
    if (result.action !== action) {
      return c.json({ error: 'action_mismatch' }, 400);
    }

    if (result.environment !== deps.environment) {
      // A staging proof is cheap to obtain; accepting one in production would
      // make personhood meaningless.
      return c.json({ error: 'environment_mismatch' }, 400);
    }

    const credential = findProofOfHuman(result);
    if (credential === undefined) {
      return c.json({ error: 'missing_proof_of_human' }, 400);
    }

    if (!isBoundToReviewer(credential, reviewer)) {
      // Covers both a signal for another wallet and a proof with no signal.
      return c.json({ error: 'signal_mismatch' }, 400);
    }

    // Decline a request that is already unusable before paying for an external
    // call. Advisory only: the consume below is still the authority, and the
    // answer can go stale in between — which is why the same classification runs
    // again there, against a later clock reading.
    const unusable = await deps.repo.checkWorldIdRequestUsable({
      nonce: result.nonce,
      rpId: deps.rpId,
      action,
      agentId: agentId.toString(10),
      now: clock(),
    });
    if (unusable !== undefined) {
      const mapped = CONSUME_FAILURES[unusable];
      return mapped === undefined
        ? c.json({ error: 'request_not_usable' }, 400)
        : c.json({ error: mapped.error }, mapped.status);
    }

    const outcome = await deps.verifier(result);
    if (!outcome.ok) {
      switch (outcome.failure.kind) {
        case 'unavailable':
          return c.json({ error: 'verification_unavailable' }, 503);
        case 'malformed':
          return c.json({ error: 'verification_malformed' }, 502);
        case 'rejected':
          // The API's code is an opaque identifier, safe to pass on; its
          // `detail` can quote the proof, so it is dropped.
          return c.json(
            {
              error: 'proof_rejected',
              ...(outcome.failure.code === undefined ? {} : { code: outcome.failure.code }),
            },
            400,
          );
      }
    }

    const verified = findVerifiedResult(outcome.response, PROOF_OF_HUMAN_IDENTIFIER);
    if (verified === undefined) {
      // 200 means "at least one proof verified", so the required credential may
      // still have failed inside `results`.
      return c.json({ error: 'proof_of_human_not_verified' }, 400);
    }

    // Canonicalised, not merely validated: this is the value the UNIQUE
    // (agent_id, nullifier) index is built on, so two encodings of one
    // identity must not become two rows. See normalizeNullifier.
    const nullifier = normalizeNullifier(verified.nullifier);
    if (nullifier === undefined) {
      return c.json({ error: 'verification_malformed' }, 502);
    }

    // `environment` is optional in the response; cross-check only when present.
    if (
      outcome.response.environment !== undefined &&
      outcome.response.environment !== deps.environment
    ) {
      return c.json({ error: 'environment_mismatch' }, 400);
    }
    // `action` is optional too.
    if (outcome.response.action !== undefined && outcome.response.action !== action) {
      return c.json({ error: 'action_mismatch' }, 400);
    }

    // Read the clock again rather than reusing the pre-check's value. The
    // verification above is a network round trip, and a request can expire
    // while it is in flight; consuming against the earlier reading would admit
    // a request that is expired by the time it is spent. This is also the
    // timestamp stored on the verification, so the record dates from when the
    // proof was accepted.
    const now = clock();

    const recorded = await deps.repo.consumeAndRecordVerification({
      nonce: result.nonce,
      rpId: deps.rpId,
      action,
      agentId: agentId.toString(10),
      reviewer,
      nullifier,
      now,
    });

    if (!recorded.ok) {
      const mapped = CONSUME_FAILURES[recorded.reason];
      // Every ConsumeFailure and 'already_reviewed' is covered; the fallback
      // keeps an unmapped reason from leaking as a 500.
      return mapped === undefined
        ? c.json({ error: 'request_not_usable' }, 400)
        : c.json({ error: mapped.error }, mapped.status);
    }

    const response: ReviewProofResponse = {
      agent_id: recorded.verification.agentId,
      reviewer: recorded.verification.reviewer,
      nullifier: recorded.verification.nullifier,
      verified_at: recorded.verification.verifiedAt,
    };

    return c.json(response, 200);
  });

  return app;
}

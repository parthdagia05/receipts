import { IDKit, proofOfHuman } from '@worldcoin/idkit-core';
import type { IDKitErrorCode } from '@worldcoin/idkit-core';
import type { Address } from 'viem';
import type { WorldIdRequestResponse } from './api';

/**
 * World ID 4.0 verification, driven from the browser.
 *
 * `@worldcoin/idkit-core` is used directly rather than the React widget: the
 * server already mints the signed `rp_context` and derives the action, so all
 * that is left is to open a request, show its connector URI as a QR code and
 * poll. That also keeps the frontend on the exact package version the Record
 * Server validates proofs against.
 *
 * The signal is the reviewer's wallet address. It binds the proof to that
 * wallet — `isBoundToReviewer` on the server recomputes `hashSignal(reviewer)`
 * and rejects anything else, so a proof cannot be replayed for a different
 * address.
 */

export interface WorldIdSession {
  /** Show this as a QR code, and link it for users already on a phone. */
  readonly connectorURI: string;
  /** Resolves when World App completes, rejects on failure or timeout. */
  readonly completion: Promise<unknown>;
}

export class WorldIdError extends Error {
  readonly code: IDKitErrorCode | 'timeout' | 'failed';

  constructor(code: WorldIdError['code'], message: string) {
    super(message);
    this.name = 'WorldIdError';
    this.code = code;
  }
}

/**
 * What each World App failure means for the person looking at the screen.
 *
 * Codes not listed here keep their raw value in the message, which is better
 * than a generic string when something genuinely unexpected happens.
 */
const ERROR_COPY: Partial<Record<IDKitErrorCode, string>> = {
  user_rejected: 'Verification was cancelled in World App.',
  verification_rejected: 'World App rejected the verification.',
  credential_unavailable: 'This World ID has no Proof of Human credential.',
  max_verifications_reached: 'This World ID has already been used for this agent.',
  nullifier_replayed: 'This World ID has already verified for this agent.',
  invalid_rp_signature: 'The server’s request signature was rejected. Check the RP configuration.',
  rp_signature_expired: 'The verification request expired before it was scanned.',
  unknown_rp: 'World ID does not recognise this relying party.',
  inactive_rp: 'This relying party is not active in the Developer Portal.',
  world_id_4_not_available: 'This World App version does not support World ID 4.0.',
  connection_failed: 'Could not reach World App.',
  invalid_network: 'World App is on a different network.',
};

export function describeWorldIdError(error: unknown): string {
  if (error instanceof WorldIdError) return error.message;
  if (error instanceof Error) return error.message;
  return 'World ID verification failed.';
}

/**
 * Open a verification request for one agent.
 *
 * `allow_legacy_proofs: false` because the Record Server accepts v4 payloads
 * only — `parseIDKitResult` rejects anything whose `protocol_version` is not
 * "4.0", so offering a v3 fallback would produce proofs the server discards.
 *
 * `environment` comes from the server's response, never from this module or
 * from anything the user can set. IDKit defaults to production, so without it
 * a staging deployment would send its users to the production bridge and every
 * proof would come back in the wrong environment.
 *
 * Relaying it does not hand the client any authority. The server compares the
 * environment inside the returned proof against its own configuration, both
 * before and after Portal verification, and rejects a mismatch — so this only
 * decides where the request is opened, not whether its result is honoured.
 */
export async function startVerification(
  request: WorldIdRequestResponse,
  reviewer: Address,
): Promise<WorldIdSession> {
  const idkitRequest = await IDKit.request({
    app_id: request.app_id as `app_${string}`,
    action: request.action,
    rp_context: request.rp_context,
    environment: request.environment,
    allow_legacy_proofs: false,
  }).preset(proofOfHuman({ signal: reviewer }));

  const completion = idkitRequest.pollUntilCompletion().then((outcome) => {
    if (!outcome.success) {
      const code = outcome.error as unknown as IDKitErrorCode;
      throw new WorldIdError(code, ERROR_COPY[code] ?? `World ID verification failed (${code}).`);
    }
    // Forwarded to the server exactly as received: it validates and relays the
    // whole result to the Developer Portal, and rebuilding the object here
    // would drop fields the Portal verifies.
    return outcome.result;
  });

  return { connectorURI: idkitRequest.connectorURI, completion };
}

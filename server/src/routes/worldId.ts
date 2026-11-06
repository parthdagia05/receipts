import { Hono } from 'hono';
import type { Repository } from '../db/repository.js';
import { InvalidAgentIdError, parseAgentId, reviewAgentAction } from '../worldid/action.js';
import type { WorldIdEnvironment } from '../worldid/proof.js';
import { RpSigningError } from '../worldid/signing.js';
import type { RpContext, RpContextSigner } from '../worldid/signing.js';

export interface WorldIdDeps {
  /** The `app_` identifier the frontend initializes IDKit with. */
  readonly appId: string;
  /** The environment this deployment verifies against. Server-configured. */
  readonly environment: WorldIdEnvironment;
  readonly signer: RpContextSigner;
  readonly repo: Repository;
}

/** Everything the frontend needs to open an IDKit request. */
export interface WorldIdRequestResponse {
  readonly app_id: string;
  readonly action: string;
  readonly rp_context: RpContext;
  /**
   * Which World environment to open the request against.
   *
   * Advisory only. IDKit defaults to production, so a staging deployment has
   * no way to tell the browser where to go without this — but it is told, not
   * asked: `reviewProof` compares the environment inside the returned proof
   * against this same server-side value and rejects a mismatch. A browser that
   * ignores this field, or substitutes another value, produces a proof the
   * server refuses. It is never read back off the wire as an input.
   */
  readonly environment: WorldIdEnvironment;
}

/**
 * `POST /api/world-id/request` — mint an RP-signed World ID request.
 *
 * The action is derived from the validated `agentId` and never read from the
 * body: accepting a client-supplied action would let a caller pick the
 * nullifier scope, and so review an agent under an action nobody is tracking.
 * An unknown body field is simply ignored.
 */
export function worldIdRoute(deps: WorldIdDeps): Hono {
  const app = new Hono();

  app.post('/api/world-id/request', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'invalid_request', message: 'body must be a JSON object' }, 400);
    }

    let agentId: bigint;
    try {
      agentId = parseAgentId((body as Record<string, unknown>)['agentId']);
    } catch (err) {
      if (err instanceof InvalidAgentIdError) {
        return c.json({ error: 'invalid_agent_id', message: err.message }, 400);
      }
      throw err;
    }

    const action = reviewAgentAction(agentId);

    let rpContext: RpContext;
    try {
      rpContext = deps.signer(action);
    } catch (err) {
      if (err instanceof RpSigningError) {
        // Deliberately opaque: the cause is a server-side key or SDK fault, and
        // the detail is of no use to the caller.
        return c.json({ error: 'signing_failed' }, 500);
      }
      throw err;
    }

    // Record before responding. A caller must never hold a signed request the
    // database does not know about: verification will look the nonce up, and an
    // unrecorded one is indistinguishable from a forged one.
    try {
      await deps.repo.recordWorldIdRequest({
        nonce: rpContext.nonce,
        rpId: rpContext.rp_id,
        action,
        agentId: agentId.toString(10),
        createdAt: rpContext.created_at,
        expiresAt: rpContext.expires_at,
      });
    } catch {
      // Opaque on purpose: the cause is a server-side storage fault, and the
      // detail would describe the schema. The nonce itself is never logged.
      return c.json({ error: 'request_not_persisted' }, 500);
    }

    const response: WorldIdRequestResponse = {
      app_id: deps.appId,
      action,
      rp_context: rpContext,
      environment: deps.environment,
    };

    return c.json(response, 200);
  });

  return app;
}

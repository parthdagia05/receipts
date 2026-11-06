import { Hono } from 'hono';
import type { Repository } from '../db/repository.js';

export interface HealthDeps {
  readonly repo: Repository;
}

/** Health payload. Deliberately carries no configuration and no secrets. */
export interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly uptimeSeconds: number;
  readonly checks: {
    readonly database: 'ok' | 'unreachable';
  };
}

/**
 * `GET /health` — liveness plus database reachability.
 *
 * Returns 200 when every check passes and 503 when any fails, so a load
 * balancer can act on the status code without parsing the body. The body names
 * which check failed but never why, since driver errors can leak the database
 * path.
 */
export function healthRoute(deps: HealthDeps): Hono {
  const app = new Hono();

  app.get('/health', async (c) => {
    const databaseOk = await deps.repo.isReachable();
    const body: HealthResponse = {
      status: databaseOk ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      checks: {
        database: databaseOk ? 'ok' : 'unreachable',
      },
    };

    return c.json(body, databaseOk ? 200 : 503);
  });

  return app;
}

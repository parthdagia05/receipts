import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { IN_MEMORY, openDatabase } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { VALID_ENV, appDeps } from './fixtures.js';

describe('GET /health', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Already closed by a test that exercised the unreachable path.
    }
  });

  it('returns 200 with ok status when the database is reachable', async () => {
    const app = createApp(appDeps(db));
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: 'ok',
      checks: { database: 'ok' },
    });
  });

  it('reports a non-negative integer uptime', async () => {
    const app = createApp(appDeps(db));
    const body = (await (await app.request('/health')).json()) as { uptimeSeconds: number };

    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 and degraded status when the database is unreachable', async () => {
    const app = createApp(appDeps(db));
    db.close();

    const res = await app.request('/health');

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      status: 'degraded',
      checks: { database: 'unreachable' },
    });
  });

  it('exposes no configuration or secrets', async () => {
    const app = createApp(appDeps(db));
    const text = await (await app.request('/health')).text();

    // Numeric settings are omitted: a small uptime could coincide with one.
    const sensitive = [
      VALID_ENV.WORLD_APP_ID,
      VALID_ENV.WORLD_RP_ID,
      VALID_ENV.WORLD_SIGNING_KEY,
      VALID_ENV.RECORD_SERVER_PRIVATE_KEY,
      VALID_ENV.REVIEW_GATEWAY_ADDRESS,
      VALID_ENV.DATABASE_PATH,
    ];
    for (const value of sensitive) {
      expect(text).not.toContain(value);
    }

    // No configuration keys leak either, whatever their values.
    for (const key of [
      'chainId',
      'reviewGatewayAddress',
      'worldAppId',
      'worldRpId',
      'databasePath',
    ]) {
      expect(text).not.toContain(key);
    }
  });

  it('returns only the documented fields', async () => {
    const app = createApp(appDeps(db));
    const body = (await (await app.request('/health')).json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(['checks', 'status', 'uptimeSeconds']);
    expect(Object.keys(body.checks as object)).toEqual(['database']);
  });
});

describe('app routing', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
  });

  afterEach(() => {
    db.close();
  });

  it('returns a 404 body without detail for an unknown route', async () => {
    const app = createApp(appDeps(db));
    const res = await app.request('/does-not-exist');

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'not_found' });
  });
});

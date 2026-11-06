import { serve } from '@hono/node-server';
import { createPublicClient, getAddress, http } from 'viem';
import { createApp } from './app.js';
import { createAttestationSignerFromEnv } from './signing/signer.js';
import { createPublicClientReader } from './signing/walletSignature.js';
import { createRpcGatewayReader } from './chain/gateway.js';
import { DeploymentVerificationError, verifyDeployment } from './chain/verifyDeployment.js';
import { EnvValidationError, loadEnv, redactEnv } from './config/env.js';
import type { Env } from './config/env.js';
import { openDatabase } from './db/index.js';
import { createSqliteRepository } from './db/sqliteRepository.js';
import { applySchema, createPool } from './db/postgres/pool.js';
import { createPostgresRepository } from './db/postgres/repository.js';
import type { Repository } from './db/repository.js';
import { DEFAULT_RATE_LIMITS } from './middleware/rateLimit.js';
import { runMigrations } from './db/migrate.js';
import { createRpContextSigner } from './worldid/signing.js';
import { createWorldIdVerifier } from './worldid/verifyClient.js';

function loadEnvOrExit(): Env {
  try {
    return loadEnv();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      // Safe to print in full: issues name variables and expected shapes only.
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const env = loadEnvOrExit();

  // Before accepting traffic: confirm this server can produce attestations the
  // configured gateway will accept. Both failure modes are otherwise invisible
  // until a user's review reverts on-chain.
  try {
    const { recordServerAddress, chainId } = await verifyDeployment({
      reader: createRpcGatewayReader({
        rpcUrl: env.rpcUrl,
        gatewayAddress: env.reviewGatewayAddress,
      }),
      recordServerPrivateKey: env.recordServerPrivateKey,
      expectedChainId: env.chainId,
    });
    console.log(`[server] record server ${recordServerAddress} verified on chain ${chainId}`);
  } catch (err) {
    if (err instanceof DeploymentVerificationError) {
      // Addresses and chain ids only; no key or RPC URL.
      console.error(`[server] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Database selection is explicit, never inferred, and never falls back.
  // `loadEnv` has already refused to start a production process on anything
  // but postgres, so reaching the sqlite branch here means a developer asked
  // for it.
  let repo: Repository;
  let closeDatabase: () => Promise<void>;

  if (env.databaseDriver === 'postgres') {
    if (env.databaseUrl === undefined) {
      // Unreachable: validation requires it. Narrowing, not a guard.
      console.error('[server] DATABASE_URL is required for the postgres driver');
      process.exit(1);
    }

    const pool = createPool({ connectionString: env.databaseUrl });
    try {
      // Idempotent and advisory-locked, so two tasks starting together
      // apply it once. Schema initialisation only -- it never migrates data.
      await applySchema(pool);
    } catch (err) {
      // Fail fast and loudly. A server that cannot reach its database must
      // not start and must not silently use a different one. The message is
      // the error's name only: the detail can carry the connection string.
      console.error(
        `[server] could not initialise the PostgreSQL schema: ${
          err instanceof Error ? err.name : 'unknown error'
        }`,
      );
      await pool.end().catch(() => undefined);
      process.exit(1);
    }

    repo = createPostgresRepository(pool);
    closeDatabase = async () => {
      await pool.end();
    };
    console.log('[server] database: postgres');
  } else {
    const db = openDatabase(env.databasePath);
    const applied = runMigrations(db);
    if (applied.length > 0) {
      console.log(`[server] applied migrations: ${applied.join(', ')}`);
    }
    repo = createSqliteRepository(db);
    closeDatabase = async () => {
      db.close();
    };
    console.log('[server] database: sqlite');
  }


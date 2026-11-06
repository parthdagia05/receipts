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

  const app = createApp({
    repo,
    worldAppId: env.worldAppId,
    worldRpId: env.worldRpId,
    worldEnvironment: env.worldEnvironment,
    chainId: env.chainId,
    reviewGatewayAddress: env.reviewGatewayAddress,
    reviewContentBaseUrl: env.reviewContentBaseUrl,
    attestationSigner: createAttestationSignerFromEnv(env),
    contractWalletReader: createPublicClientReader(
      createPublicClient({ transport: http(env.rpcUrl) }),
    ),
    rpContextSigner: createRpContextSigner({
      signingKeyHex: env.worldSigningKey,
      rpId: env.worldRpId,
    }),
    worldIdVerifier: createWorldIdVerifier({ rpId: env.worldRpId }),
    corsAllowedOrigins: env.corsAllowedOrigins,
    walletReviewsEnabled: env.walletReviewsEnabled,
    // Always on in the real server, unlike in tests. The limits are far
    // above legitimate use; see DEFAULT_RATE_LIMITS.
    rateLimit: { ...DEFAULT_RATE_LIMITS, trustProxy: env.trustProxy },
    ...(env.receiptSettlerAddress === undefined ||
    env.identityRegistryAddress === undefined ||
    env.reputationRegistryAddress === undefined
      ? {}
      : {
          reputation: {
            client: createPublicClient({ transport: http(env.rpcUrl) }),
            chainId: env.chainId,
            contracts: {
              reviewGateway: env.reviewGatewayAddress,
              receiptSettler: env.receiptSettlerAddress,
              identityRegistry: env.identityRegistryAddress,
              reputationRegistry: env.reputationRegistryAddress,
            },
            gatewayDeployBlock: env.gatewayDeployBlock,
            // Older gateways keep counting after a replacement. Spread
            // conditionally so an empty list changes nothing.
            ...(env.additionalGateways.length === 0
              ? {}
              : { additionalGateways: env.additionalGateways }),
            confirmations: env.reputationConfirmations,
          },
        }),
  });

  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
    console.log(`[server] listening on port ${info.port}`);
    console.log('[server] config:', redactEnv(env));
  });

  const shutdown = (signal: string): void => {
    console.log(`[server] ${signal} received, shutting down`);
    server.close(() => {
      // Release connections before exiting. For PostgreSQL this drains the
      // pool, so sockets are closed rather than left for the database to
      // time out; for SQLite it closes the file handle. Either way the exit
      // waits for it, so a shutdown cannot race the close.
      void closeDatabase()
        .catch((err: unknown) => {
          console.error(
            `[server] error closing the database: ${err instanceof Error ? err.name : 'unknown'}`,
          );
        })
        .finally(() => {
          process.exit(0);
        });
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[server] startup failed:', err instanceof Error ? err.name : 'unknown error');
  process.exit(1);
});

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Address } from 'viem';
import type { Repository } from './db/repository.js';
import { rateLimit } from './middleware/rateLimit.js';
import type { RateLimitConfig } from './middleware/rateLimit.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { healthRoute } from './routes/health.js';
import { reviewAttestRoute } from './routes/reviewAttest.js';
import { reviewContentRoute } from './routes/reviewContent.js';
import { reviewPrepareRoute } from './routes/reviewPrepare.js';
import { reviewProofRoute } from './routes/reviewProof.js';
import { walletReviewPrepareRoute } from './routes/walletReviewPrepare.js';
import { reputationRoute } from './routes/reputation.js';
import { reputationSimulateRoute } from './routes/reputationSimulate.js';
import type { ReputationDeps } from './routes/reputation.js';
import { worldIdRoute } from './routes/worldId.js';
import type { AttestationSigner } from './signing/signer.js';
import type { WorldIdEnvironment } from './worldid/proof.js';
import type { ContractWalletReader } from './signing/walletSignature.js';
import type { RpContextSigner } from './worldid/signing.js';
import type { WorldIdVerifier } from './worldid/verifyClient.js';

export interface AppDeps {
  /**
   * Database access, as an interface rather than a driver handle.
   *
   * The routes no longer know which backend is underneath: production
   * injects PostgreSQL, tests inject SQLite. That substitution is the point
   * -- a route that imported a SQLite module directly could not be run
   * against the database it will actually run against.
   */
  readonly repo: Repository;
  /** The `app_` identifier served to the frontend for IDKit. */
  readonly worldAppId: string;
  /** The `rp_` identifier proofs must be scoped to. */
  readonly worldRpId: string;
  /** The environment proofs must be produced in. */
  readonly worldEnvironment: WorldIdEnvironment;
  /** Injected so tests can sign deterministically. */
  readonly rpContextSigner: RpContextSigner;
  /** Injected so tests need no live World ID access. */
  readonly worldIdVerifier: WorldIdVerifier;
  /** Chain the ReviewGateway is deployed on; the EIP-712 domain's chainId. */
  readonly chainId: number;
  /** Deployed ReviewGateway; the EIP-712 domain's verifyingContract. */
  readonly reviewGatewayAddress: Address;
  /** Base URL the signed evidence URI is derived from. */
  readonly reviewContentBaseUrl: string;
  /** Signs gateway attestations; its address must equal `recordServerSigner`. */
  readonly attestationSigner: AttestationSigner;
  /** Omit to verify EOA wallet signatures only, with no chain access. */
  readonly contractWalletReader?: ContractWalletReader;
  /** Injectable clock, Unix seconds. */
  readonly now?: () => number;
  /**
   * Chain access for the reputation engine.
   *
   * Optional: omitted, the reputation endpoint is simply not mounted, so a
   * test that only exercises the review flow needs no chain double.
   */
  readonly reputation?: ReputationDeps;
  /**
   * Origins permitted to call `/api/*` from a browser.
   *
   * Omitted, no CORS middleware is mounted at all, which is what local
   * development wants: Vite proxies the API onto its own origin, so the
   * requests are same-origin and no header is needed. Production must set
   * it, because the app and the API are on different subdomains.
   *
   * Never `*`. These endpoints spend a World ID verification and consume a
   * signing challenge on unauthenticated requests.
   */
  readonly corsAllowedOrigins?: readonly string[];
  /**
   * Request limiting. Omitted, no limiter is mounted.
   *
   * Opt-in rather than on-by-default so that mounting the app in a test does
   * not silently change what a burst of requests does.
   */
  readonly rateLimit?: RateLimitConfig;
  /**
   * Accept wallet-verified (reviewType 2) reviews. Omitted means false: the
   * wallet endpoints answer 503 and wallet challenges are never attested.
   */
  readonly walletReviewsEnabled?: boolean;
}

/**
 * Build the HTTP app.
 *
 * Takes its dependencies rather than reading configuration, so tests can mount
 * the real routes against an in-memory database without binding a port or
 * populating the environment.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // Ordering is deliberate. Headers apply to every response including
  // errors and 429s, so they go first. The limiter runs before any route so
  // a rejected request costs nothing downstream. CORS is scoped to `/api/*`
  // because `/reviews/:feedbackHash` is published content meant to be
  // fetched from anywhere, and `/health` is for load balancers.
  app.use('*', securityHeaders());

  if (deps.rateLimit !== undefined) {
    app.use('*', rateLimit(deps.rateLimit));
  }

  if (deps.corsAllowedOrigins !== undefined && deps.corsAllowedOrigins.length > 0) {
    const allowed = [...deps.corsAllowedOrigins];
    app.use(
      '/api/*',
      cors({
        origin: (origin) => (allowed.includes(origin) ? origin : null),
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['content-type'],
        maxAge: 86_400,
        credentials: false,
      }),
    );
  }

  app.route('/', healthRoute({ repo: deps.repo }));
  app.route('/', reviewContentRoute({ repo: deps.repo }));
  app.route(
    '/',
    worldIdRoute({
      appId: deps.worldAppId,
      environment: deps.worldEnvironment,
      signer: deps.rpContextSigner,
      repo: deps.repo,
    }),
  );
  app.route(
    '/',
    reviewProofRoute({
      repo: deps.repo,
      rpId: deps.worldRpId,
      environment: deps.worldEnvironment,
      verifier: deps.worldIdVerifier,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  );
  app.route(
    '/',
    reviewPrepareRoute({
      repo: deps.repo,
      chainId: deps.chainId,
      reviewGatewayAddress: deps.reviewGatewayAddress,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  );
  app.route(
    '/',
    walletReviewPrepareRoute({
      repo: deps.repo,
      chainId: deps.chainId,
      reviewGatewayAddress: deps.reviewGatewayAddress,
      enabled: deps.walletReviewsEnabled === true,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  );
  app.route(
    '/',
    reviewAttestRoute({
      walletReviewsEnabled: deps.walletReviewsEnabled === true,
      repo: deps.repo,
      chainId: deps.chainId,
      reviewGatewayAddress: deps.reviewGatewayAddress,
      reviewContentBaseUrl: deps.reviewContentBaseUrl,
      attestationSigner: deps.attestationSigner,
      ...(deps.contractWalletReader === undefined
        ? {}
        : { contractWalletReader: deps.contractWalletReader }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  );

  if (deps.reputation !== undefined) {
    app.route('/', reputationRoute(deps.reputation));
  }

  // Always mounted: it needs no chain access. Its output is marked
  // `simulated` and carries no evidence hash, and it shares nothing with the
  // live scoring path except the engine itself.
  app.route('/', reputationSimulateRoute());

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  // Error bodies are a fixed string: an exception message can carry a file path
  // or a value read from the environment, neither of which belongs in a response.
  app.onError((err, c) => {
    console.error('[server] unhandled error:', err.name);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}

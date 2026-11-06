import { getAddress } from 'viem';
import type { AppDeps } from '../src/app.js';
import type { Db } from '../src/db/index.js';
import { createSqliteRepository } from '../src/db/sqliteRepository.js';
import { createAttestationSigner } from '../src/signing/signer.js';
import type { AttestationSigner } from '../src/signing/signer.js';
import { RpSigningError } from '../src/worldid/signing.js';
import type { RpContextSigner } from '../src/worldid/signing.js';
import type { VerifyOutcome, WorldIdVerifier } from '../src/worldid/verifyClient.js';

/**
 * Synthetic configuration for tests. None of these are real credentials: the
 * keys and address are fixed repeating bytes, and the identifiers are literals.
 */
export const VALID_ENV = {
  PORT: '3000',
  NODE_ENV: 'test',
  WORLD_APP_ID: 'app_staging_testtesttesttest',
  WORLD_RP_ID: 'rp_staging_testtesttesttest',
  WORLD_ENVIRONMENT: 'production',
  WORLD_SIGNING_KEY: `0x${'33'.repeat(32)}`,
  RECORD_SERVER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  REVIEW_GATEWAY_ADDRESS: `0x${'22'.repeat(20)}`,
  CHAIN_ID: '11155111',
  REVIEW_CONTENT_BASE_URL: 'https://receipts.test',
  RPC_URL: 'https://rpc.example.invalid/v1/test-api-key-not-real',
  DATABASE_PATH: ':memory:',
} as const satisfies Record<string, string>;

/**
 * A signer with a fixed output, so route assertions can pin exact values.
 *
 * The real signer draws a random nonce per call and stamps wall-clock times,
 * neither of which a response test can assert against. `actions` records what
 * the route asked for, which is how the action-derivation tests check that the
 * server never signs a client-supplied action.
 */
export function fakeRpContextSigner(rpId = VALID_ENV.WORLD_RP_ID): {
  signer: RpContextSigner;
  actions: string[];
} {
  const actions: string[] = [];
  const signer: RpContextSigner = (action) => {
    actions.push(action);
    return {
      rp_id: rpId,
      nonce: `0x${'ab'.repeat(32)}`,
      created_at: 1_793_740_542,
      expires_at: 1_793_740_842,
      signature: `0x${'cd'.repeat(65)}`,
    };
  };
  return { signer, actions };
}

/** A signer that always fails, for the error path. */
export const failingRpContextSigner: RpContextSigner = () => {
  throw new RpSigningError();
};

/**
 * A verifier returning a fixed outcome, so proof-path tests need no network.
 *
 * `calls` records each forwarded result, which is how the tests check that a
 * locally-rejected proof never reaches the Portal.
 */
export function fakeWorldIdVerifier(outcome?: VerifyOutcome): {
  verifier: WorldIdVerifier;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const verifier: WorldIdVerifier = async (result) => {
    calls.push(result);
    return (
      outcome ?? {
        ok: true,
        response: {
          success: true,
          results: [{ identifier: 'proof_of_human', success: true, nullifier: TEST_NULLIFIER }],
          action: 'review-agent-42',
          environment: 'production',
        },
      }
    );
  };
  return { verifier, calls };
}

/** The nullifier the default fake verifier reports. Decimal, as v4 returns. */
export const TEST_NULLIFIER = '123456789012345678901234567890';

/**
 * The Record Server signer used by route tests.
 *
 * Built from the synthetic key in VALID_ENV, so attestation signatures can be
 * recovered and checked against a known address.
 */
export function testAttestationSigner(): AttestationSigner {
  return createAttestationSigner({
    privateKey: VALID_ENV.RECORD_SERVER_PRIVATE_KEY,
    chainId: Number(VALID_ENV.CHAIN_ID),
    reviewGatewayAddress: getAddress(VALID_ENV.REVIEW_GATEWAY_ADDRESS),
  });
}

/** Default app dependencies for route tests, with `overrides` applied. */
/**
 * Build `AppDeps` from a raw SQLite handle.
 *
 * Wrapping the handle here rather than at every call site is what keeps the
 * existing tests unchanged after the routes moved to the repository
 * interface: they still pass a `Db`, and the SQLite implementation is
 * constructed for them.
 */
export function appDeps(db: Db, overrides: Partial<Omit<AppDeps, 'repo'>> = {}): AppDeps {
  return {
    repo: createSqliteRepository(db),
    worldAppId: VALID_ENV.WORLD_APP_ID,
    worldRpId: VALID_ENV.WORLD_RP_ID,
    chainId: Number(VALID_ENV.CHAIN_ID),
    reviewGatewayAddress: getAddress(VALID_ENV.REVIEW_GATEWAY_ADDRESS),
    reviewContentBaseUrl: VALID_ENV.REVIEW_CONTENT_BASE_URL,
    attestationSigner: testAttestationSigner(),
    worldEnvironment: VALID_ENV.WORLD_ENVIRONMENT,
    rpContextSigner: fakeRpContextSigner().signer,
    worldIdVerifier: fakeWorldIdVerifier().verifier,
    ...overrides,
  };
}

/** A copy of VALID_ENV with `overrides` applied; `undefined` removes a key. */
export function envWith(
  overrides: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const merged: Record<string, string> = { ...VALID_ENV };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

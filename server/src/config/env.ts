import { readFileSync } from 'node:fs';
import { isAddress, getAddress } from 'viem';
import type { Address } from 'viem';
import { normalizeReviewContentBaseUrl } from '../signing/feedbackUri.js';

/**
 * Validated server configuration.
 *
 * Fields marked secret are never written to logs or error messages: validation
 * reports the variable name and the expected shape, never the observed value.
 */
export interface Env {
  readonly port: number;
  readonly nodeEnv: NodeEnv;
  /** The `app_` identifier IDKit is initialized with. */
  readonly worldAppId: string;
  /** The `rp_` relying-party identifier carried in rp_context. */
  readonly worldRpId: string;
  /** The World ID environment proofs must be produced in. */
  readonly worldEnvironment: WorldEnvironment;
  /** Secret. World Developer Portal RP signing key (32-byte hex). */
  readonly worldSigningKey: `0x${string}`;
  /** Secret. EOA key whose address must equal the gateway's recordServerSigner. */
  readonly recordServerPrivateKey: `0x${string}`;
  readonly reviewGatewayAddress: Address;
  readonly chainId: number;
  /** Secret-ish. A JSON-RPC URL commonly embeds an API key, so it is redacted
   *  like a credential and never appears in an error message. */
  readonly rpcUrl: string;
  /** Base URL the signed evidence URI is derived from. */
  readonly reviewContentBaseUrl: string;
  readonly databasePath: string;
  /**
   * Addresses the reputation engine reads. Optional as a group: without them
   * the reputation endpoint is not mounted and the rest of the server runs
   * unchanged, so an existing deployment keeps working after an upgrade.
   */
  readonly receiptSettlerAddress: Address | undefined;
  readonly identityRegistryAddress: Address | undefined;
  readonly reputationRegistryAddress: Address | undefined;
  /** First block the gateway can have emitted an event in. */
  readonly gatewayDeployBlock: bigint;
  /** Blocks to stay behind the head when pinning a reputation snapshot. */
  readonly reputationConfirmations: bigint;
  /**
   * Browser origins allowed to call `/api/*`. Empty disables CORS entirely,
   * which is correct for local development behind the Vite proxy.
   */
  readonly corsAllowedOrigins: readonly string[];
  /**
   * Which database backend to open. Explicit, never inferred.
   *
   * `postgres` requires `DATABASE_URL`; `sqlite` uses `DATABASE_PATH`. In
   * production only `postgres` is accepted -- see the validation below.
   */
  readonly databaseDriver: DatabaseDriver;
  /** PostgreSQL connection string. Secret: it carries a password. */
  readonly databaseUrl: string | undefined;
  /**
   * Whether to believe `X-Forwarded-For` when identifying a client.
   *
   * True only when a proxy that overwrites the header sits in front. Trusting
   * it on a directly-exposed server lets any caller forge an address and
   * bypass rate limiting.
   */
  readonly trustProxy: boolean;
  /**
   * Whether wallet-verified (reviewType 2) reviews are accepted. Default false.
   *
   * Off, the wallet endpoints answer 503 and wallet challenges cannot be
   * attested. It stays off until the deployed gateway has `submitWalletReview`:
   * the Sepolia gateway at the time of writing does not, so an attestation
   * issued for it would revert on-chain.
   */
  readonly walletReviewsEnabled: boolean;
  /**
   * Earlier gateways whose reviews must keep counting after
   * `REVIEW_GATEWAY_ADDRESS` moves to a new deployment (for instance one that
   * adds `submitWalletReview`). Read-only for reputation: attestations are
   * only ever signed for, and bound to, the primary gateway.
   */
  readonly additionalGateways: readonly AdditionalGateway[];
}

/**
 * A previous (or additional) ReviewGateway whose reviews still count toward
 * reputation. Structurally the reputation engine's `GatewaySource`.
 */
export interface AdditionalGateway {
  readonly address: Address;
  /** First block worth scanning for this gateway. */
  readonly fromBlock: bigint;
}

export type NodeEnv = 'development' | 'test' | 'production';

/** Supported database backends. */
export type DatabaseDriver = 'sqlite' | 'postgres';

const DATABASE_DRIVERS: readonly DatabaseDriver[] = ['sqlite', 'postgres'];

/** World ID environments, as the SDK and the verify API name them. */
export type WorldEnvironment = 'production' | 'staging' | 'sandbox';

const WORLD_ENVIRONMENTS: readonly WorldEnvironment[] = ['production', 'staging', 'sandbox'];
const DEFAULT_WORLD_ENVIRONMENT: WorldEnvironment = 'production';

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Variables whose values must never appear in logs or errors. */
export const SECRET_ENV_KEYS = [
  'WORLD_SIGNING_KEY',
  'RECORD_SERVER_PRIVATE_KEY',
  'RPC_URL',
  // Carries the database password.
  'DATABASE_URL',
] as const;

const DEFAULT_PORT = 3000;
const DEFAULT_NODE_ENV: NodeEnv = 'development';
const DEFAULT_DATABASE_PATH = './data/receipts.db';

/** One validation failure, naming the variable and the expected shape only. */
export interface EnvIssue {
  readonly key: string;
  readonly message: string;
}

/**
 * Aggregated environment validation failure.
 *
 * The message lists every issue so one run surfaces all misconfiguration. No
 * issue carries an observed value, so this is safe to log in full.
 */
export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    const detail = issues.map((i) => `  - ${i.key}: ${i.message}`).join('\n');
    super(`Invalid environment configuration:\n${detail}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

type Source = Readonly<Record<string, string | undefined>>;

/** Trimmed value, or undefined when unset or blank. */
function read(source: Source, key: string): string | undefined {
  const raw = source[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Read the RP signing key out of the file named by WORLD_SIGNING_KEY_FILE.
 *
 * Accepts the Developer Portal's JSON download (`{"privateKey": "0x..."}`) or
 * a file containing the bare hex. Returns undefined when the variable is not
 * set, so the caller falls back to WORLD_SIGNING_KEY.
 *
 * Nothing derived from the file's contents is ever put in an error: a failure
 * reports the path and the kind of fault only. `fail` is passed in rather than
 * throwing directly so this participates in the same aggregated-issue
 * reporting as every other variable.
 */
function readSigningKeyFile(
  source: Source,
  fail: (key: string, reason: string) => undefined,
): string | undefined {
  const path = read(source, 'WORLD_SIGNING_KEY_FILE');
  if (path === undefined) return undefined;

  let contents: string;
  try {
    contents = readFileSync(path, 'utf8').trim();
  } catch {
    return fail('WORLD_SIGNING_KEY_FILE', `cannot be read (${path})`);
  }

  if (contents === '') return fail('WORLD_SIGNING_KEY_FILE', `is empty (${path})`);

  if (contents.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      return fail('WORLD_SIGNING_KEY_FILE', `is not valid JSON (${path})`);
    }
    const key = (parsed as Record<string, unknown>)['privateKey'];
    if (typeof key !== 'string') {
      return fail('WORLD_SIGNING_KEY_FILE', `has no string "privateKey" field (${path})`);
    }
    return key;
  }

  return contents;
}

/** World Developer Portal identifiers; the suffix may contain underscores,
 *  as in `app_staging_<hex>`. */
const APP_ID_PATTERN = /^app_[A-Za-z0-9_-]+$/;
const RP_ID_PATTERN = /^rp_[A-Za-z0-9_-]+$/;

/** Whether `value` parses as an http(s) URL. The value is never reported. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Canonical 0x-prefixed lowercase form of a 32-byte hex key. */
function normalizeHexKey(value: string): string {
  const body = value.startsWith('0x') ? value.slice(2) : value;
  return `0x${body.toLowerCase()}`;
}

function parseIntegerInRange(value: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return undefined;
  return parsed;
}

/**
 * Validate configuration from an environment-like object.
 *
 * Collects every issue before throwing, so a single run reports all problems.
 * PORT, NODE_ENV and DATABASE_PATH fall back to defaults; the World, signer and
 * chain settings are required, since a wrong value there is a security fault
 * rather than an inconvenience.
 *
 * @throws EnvValidationError when any variable is missing or malformed.
 */
export function loadEnv(source: Source = process.env): Env {
  const issues: EnvIssue[] = [];
  const fail = (key: string, message: string): undefined => {
    issues.push({ key, message });
    return undefined;
  };

  // PORT — optional, defaults to 3000.
  const portRaw = read(source, 'PORT');
  const port =
    portRaw === undefined
      ? DEFAULT_PORT
      : (parseIntegerInRange(portRaw, 1, 65535) ??
        fail('PORT', 'must be an integer between 1 and 65535'));

  // NODE_ENV — optional, defaults to development.
  const nodeEnvRaw = read(source, 'NODE_ENV');
  const nodeEnv =
    nodeEnvRaw === undefined
      ? DEFAULT_NODE_ENV
      : NODE_ENVS.includes(nodeEnvRaw as NodeEnv)
        ? (nodeEnvRaw as NodeEnv)
        : fail('NODE_ENV', `must be one of: ${NODE_ENVS.join(', ')}`);

  // WORLD_APP_ID — required. The `app_` identifier the frontend passes to
  // IDKit. Public, but still never logged.
  const worldAppIdRaw = read(source, 'WORLD_APP_ID');
  const worldAppId =
    worldAppIdRaw === undefined
      ? fail('WORLD_APP_ID', 'is required')
      : APP_ID_PATTERN.test(worldAppIdRaw)
        ? worldAppIdRaw
        : fail('WORLD_APP_ID', 'must look like "app_<identifier>"');

  // WORLD_RP_ID — required. The `rp_` relying-party identifier carried in
  // rp_context and used as the verification endpoint's path segment. Distinct
  // from WORLD_APP_ID: World ID 4.0 scopes nullifiers to the RP, not the app.
  const worldRpIdRaw = read(source, 'WORLD_RP_ID');
  const worldRpId =
    worldRpIdRaw === undefined
      ? fail('WORLD_RP_ID', 'is required')
      : RP_ID_PATTERN.test(worldRpIdRaw)
        ? worldRpIdRaw
        : fail('WORLD_RP_ID', 'must look like "rp_<identifier>"');

  // WORLD_ENVIRONMENT — optional, defaults to production. A proof produced in
  // staging or sandbox is cheap to obtain, so accepting one where production is
  // expected would make personhood meaningless; the proof path compares against
  // this rather than trusting the proof's own value.
  const worldEnvironmentRaw = read(source, 'WORLD_ENVIRONMENT');
  const worldEnvironment =
    worldEnvironmentRaw === undefined
      ? DEFAULT_WORLD_ENVIRONMENT
      : WORLD_ENVIRONMENTS.includes(worldEnvironmentRaw as WorldEnvironment)
        ? (worldEnvironmentRaw as WorldEnvironment)
        : fail('WORLD_ENVIRONMENT', `must be one of: ${WORLD_ENVIRONMENTS.join(', ')}`);

  // WORLD_SIGNING_KEY — required, secret. The World Developer Portal RP signing
  // key. `signRequest` signs the rp_context payload with it over secp256k1
  // (EIP-191), so it must be a 32-byte hex scalar; validated here so a bad key
  // fails at boot rather than on the first request. Server-only: it is never
  // returned in a response and never logged.
  //
  // WORLD_SIGNING_KEY_FILE is an alternative source for the same value, read
  // only when WORLD_SIGNING_KEY is absent so existing deployments are wholly
  // unaffected. Keeping the key in a 0600 file rather than an env var is the
  // better arrangement: env vars leak through `docker inspect`, crash
  // reporters and child processes, whereas a file does not. The file is the
  // JSON the Developer Portal hands out, so `privateKey` is read from it; a
  // bare hex file is accepted too. Failures name the *path*, never a byte of
  // the contents.
  const worldSigningKeyRaw = read(source, 'WORLD_SIGNING_KEY') ?? readSigningKeyFile(source, fail);
  const worldSigningKey =
    worldSigningKeyRaw === undefined
      ? fail('WORLD_SIGNING_KEY', 'is required (or set WORLD_SIGNING_KEY_FILE)')
      : /^(0x)?[0-9a-fA-F]{64}$/.test(worldSigningKeyRaw)
        ? (normalizeHexKey(worldSigningKeyRaw) as `0x${string}`)
        : fail('WORLD_SIGNING_KEY', 'must be a 32-byte hex string (0x prefix optional)');

  // RECORD_SERVER_PRIVATE_KEY — required, secret. Format only; deriving the
  // address and matching it against the gateway belongs to the signing chunk.
  const privateKeyRaw = read(source, 'RECORD_SERVER_PRIVATE_KEY');
  const recordServerPrivateKey =
    privateKeyRaw === undefined
      ? fail('RECORD_SERVER_PRIVATE_KEY', 'is required')
      : /^0x[0-9a-fA-F]{64}$/.test(privateKeyRaw)
        ? (privateKeyRaw.toLowerCase() as `0x${string}`)
        : fail('RECORD_SERVER_PRIVATE_KEY', 'must be a 0x-prefixed 32-byte hex string');

  // REVIEW_GATEWAY_ADDRESS — required. Checksummed via viem.
  const gatewayRaw = read(source, 'REVIEW_GATEWAY_ADDRESS');
  const reviewGatewayAddress =
    gatewayRaw === undefined
      ? fail('REVIEW_GATEWAY_ADDRESS', 'is required')
      : !isAddress(gatewayRaw, { strict: false })
        ? fail('REVIEW_GATEWAY_ADDRESS', 'must be a 20-byte hex address')
        : getAddress(gatewayRaw) === ZERO_ADDRESS
          ? fail('REVIEW_GATEWAY_ADDRESS', 'must not be the zero address')
          : getAddress(gatewayRaw);

  // CHAIN_ID — required.
  const chainIdRaw = read(source, 'CHAIN_ID');
  const chainId =
    chainIdRaw === undefined
      ? fail('CHAIN_ID', 'is required')
      : (parseIntegerInRange(chainIdRaw, 1, Number.MAX_SAFE_INTEGER) ??
        fail('CHAIN_ID', 'must be a positive integer'));

  // RPC_URL — required. Used at startup to confirm the gateway's signer and the
  // chain. The value is never echoed: it commonly carries an API key.
  const rpcUrlRaw = read(source, 'RPC_URL');
  const rpcUrl =
    rpcUrlRaw === undefined
      ? fail('RPC_URL', 'is required')
      : isHttpUrl(rpcUrlRaw)
        ? rpcUrlRaw
        : fail('RPC_URL', 'must be an http(s) URL');

  // REVIEW_CONTENT_BASE_URL — required. The signed feedbackURI is derived from
  // this plus the feedbackHash, so changing it changes every future digest.
  const reviewContentBaseUrlRaw = read(source, 'REVIEW_CONTENT_BASE_URL');
  // Normalized, not just checked: the value is concatenated into a signed URI,
  // so a query string, fragment or embedded credential would corrupt or leak
  // into every attestation. A trailing slash is the only thing smoothed over.
  const reviewContentBaseUrlNormalized =
    reviewContentBaseUrlRaw === undefined
      ? undefined
      : normalizeReviewContentBaseUrl(reviewContentBaseUrlRaw);
  const reviewContentBaseUrl =
    reviewContentBaseUrlRaw === undefined
      ? fail('REVIEW_CONTENT_BASE_URL', 'is required')
      : reviewContentBaseUrlNormalized === null
        ? fail(
            'REVIEW_CONTENT_BASE_URL',
            'must be an http(s) URL with no query string, fragment or credentials',
          )
        : reviewContentBaseUrlNormalized;


import { getAddress, isAddress } from 'viem';
import type { Address } from 'viem';

/**
 * Public application configuration, read from `VITE_`-prefixed variables.
 *
 * Everything here ships inside the JavaScript bundle and is visible to anyone
 * who opens the app, so nothing secret may be added. The Record Server holds
 * the private key, the World ID signing key and the RPC credential; the
 * browser never sees any of them.
 *
 * Validation happens once at module load. A misconfigured address would
 * otherwise surface as an unreadable viem error on whichever page happened to
 * query it first.
 */

class ConfigError extends Error {
  constructor(key: string, message: string) {
    super(`Invalid configuration: ${key} ${message}`);
    this.name = 'ConfigError';
  }
}

function readString(key: string, fallback?: string): string {
  const raw = import.meta.env[key] as string | undefined;
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(key, 'is required');
  }
  return trimmed;
}

function readAddress(key: string, fallback: string): Address {
  const value = readString(key, fallback);
  if (!isAddress(value, { strict: false })) {
    throw new ConfigError(key, 'must be a 20-byte hex address');
  }
  return getAddress(value);
}

function readNumber(key: string, fallback: number): number {
  const raw = (import.meta.env[key] as string | undefined)?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(key, 'must be a positive integer');
  return Number(raw);
}

/**
 * Where the Record Server lives.
 *
 * An empty value means "the current origin", which is what both the Vite dev
 * proxy and a single-host deployment want. Any trailing slash is removed so
 * paths can be concatenated without producing a double slash.
 */
function readApiBaseUrl(): string {
  const raw = (import.meta.env['VITE_API_BASE_URL'] as string | undefined)?.trim() ?? '';
  return raw.replace(/\/+$/, '');
}

/**
 * The RPC endpoints to try, in order.
 *
 * A comma-separated `VITE_RPC_URL` is supported so a deployment can put its
 * own endpoint first and keep a public one behind it. The defaults are two
 * independent providers that both return permissive CORS headers, which a
 * browser needs and many public endpoints do not send.
 */
const DEFAULT_RPC_URLS = [
  'https://gateway.tenderly.co/public/sepolia',
  'https://rpc.sepolia.ethpandaops.io',
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://1rpc.io/sepolia',
] as const;

function readRpcUrls(): readonly string[] {
  const raw = (import.meta.env['VITE_RPC_URL'] as string | undefined)?.trim() ?? '';
  const supplied = raw
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url !== '');
  if (supplied.length === 0) return DEFAULT_RPC_URLS;

  // Keep a default behind whatever was supplied, unless it is already listed,
  // so a single misconfigured endpoint does not leave the app with no chain.
  const fallbacks = DEFAULT_RPC_URLS.filter((url) => !supplied.includes(url));
  return [...supplied, ...fallbacks];
}

export interface AppConfig {
  readonly chainId: number;
  readonly chainName: string;
  /** One or more JSON-RPC endpoints, tried in order. */
  readonly rpcUrls: readonly string[];
  readonly explorerUrl: string;
  readonly apiBaseUrl: string;
  readonly reviewGateway: Address;
  readonly receiptSettler: Address;
  readonly nullifierRegistry: Address;
  readonly identityRegistry: Address;
  readonly reputationRegistry: Address;
  /** First block worth scanning for gateway events. */
  readonly gatewayDeployBlock: bigint;
}

export const config: AppConfig = {
  chainId: readNumber('VITE_CHAIN_ID', 11155111),
  chainName: 'Sepolia',
  rpcUrls: readRpcUrls(),
  explorerUrl: readString('VITE_EXPLORER_URL', 'https://sepolia.etherscan.io').replace(/\/+$/, ''),
  apiBaseUrl: readApiBaseUrl(),
  reviewGateway: readAddress(
    'VITE_REVIEW_GATEWAY_ADDRESS',
    '0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD',
  ),
  receiptSettler: readAddress(
    'VITE_RECEIPT_SETTLER_ADDRESS',
    '0xC3AA7a2F43d83680f9E0B97e0Eb4fD01E421ceDe',
  ),
  nullifierRegistry: readAddress(
    'VITE_NULLIFIER_REGISTRY_ADDRESS',
    '0xBA688eDFd43719378b8D3dC333C858e8d5720a4C',
  ),
  identityRegistry: readAddress(
    'VITE_IDENTITY_REGISTRY_ADDRESS',
    '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  ),
  reputationRegistry: readAddress(
    'VITE_REPUTATION_REGISTRY_ADDRESS',
    '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  ),
  gatewayDeployBlock: BigInt(readNumber('VITE_GATEWAY_DEPLOY_BLOCK', 12064002)),
};

/** Explorer link for a transaction hash. */
export function txUrl(hash: string): string {
  return `${config.explorerUrl}/tx/${hash}`;
}

/** Explorer link for an address. */
export function addressUrl(address: string): string {
  return `${config.explorerUrl}/address/${address}`;
}

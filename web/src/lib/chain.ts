import { createPublicClient, defineChain, fallback, http } from 'viem';
import { sepolia } from 'viem/chains';
import { config } from './config';

/**
 * The chain this app reads from.
 *
 * Sepolia is used as viem defines it when `VITE_CHAIN_ID` matches, so the
 * canonical Multicall3 address and block explorer come along. Any other chain
 * id produces a minimal definition instead of silently reading Sepolia's
 * contract addresses on a different network.
 */
export const chain =
  config.chainId === sepolia.id
    ? sepolia
    : defineChain({
        id: config.chainId,
        name: config.chainName,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [...config.rpcUrls] } },
      });

/**
 * Shared read-only client.
 *
 * `batch.multicall` coalesces the many small `ownerOf` / `getAgentWallet`
 * reads a page like Explore Agents issues into a handful of `aggregate3`
 * calls. Without it, listing twenty-four agents would be a hundred separate
 * HTTP round trips and public endpoints would rate-limit the page.
 *
 * The transport is a `fallback` over every configured endpoint rather than a
 * single URL. Public RPC hosts are blocked by some networks and by most
 * ad-blocking extensions, and a browser cannot tell that apart from the host
 * being down; either way the next endpoint is tried before anything is
 * reported as unreachable. `rank: false` keeps the configured order, so a
 * deployment's own endpoint stays primary.
 */
export const publicClient = createPublicClient({
  chain,
  transport: fallback(
    config.rpcUrls.map((url) => http(url, { batch: true, retryCount: 2 })),
    { rank: false },
  ),
  batch: { multicall: { wait: 16 } },
});

/**
 * Largest block span a single `eth_getLogs` may cover.
 *
 * Public Sepolia endpoints constrain eth_getLogs hard: publicnode prunes old
 * logs entirely, 1rpc caps the range at 50 blocks, and keyless tiers elsewhere
 * cap it at 10,000. The defaults that do serve full history (Tenderly's public
 * gateway, ethpandaops) answer 10,000-block windows, so scans step backwards
 * in windows just under that rather than asking for everything at once.
 */
export const MAX_LOG_RANGE = 9_999n;

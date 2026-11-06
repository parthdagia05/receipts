import { createPublicClient, http } from 'viem';
import type { Address } from 'viem';

/**
 * The two gateway facts startup depends on.
 *
 * An interface rather than a viem client so the checks can be unit-tested
 * without a live RPC; `createRpcGatewayReader` is the only implementation that
 * touches the network.
 */
export interface GatewayReader {
  /** The chain the RPC endpoint actually serves. */
  getChainId(): Promise<number>;
  /** The gateway's immutable `recordServerSigner`. */
  getRecordServerSigner(): Promise<Address>;
}

/** Just the one view function; a full ABI would be dead weight. */
const GATEWAY_ABI = [
  {
    type: 'function',
    name: 'recordServerSigner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

export interface RpcGatewayReaderConfig {
  /** May embed an API key, so it is treated as a credential throughout. */
  readonly rpcUrl: string;
  readonly gatewayAddress: Address;
}

/** A reader backed by a JSON-RPC endpoint. */
export function createRpcGatewayReader(config: RpcGatewayReaderConfig): GatewayReader {
  const client = createPublicClient({ transport: http(config.rpcUrl) });

  return {
    async getChainId() {
      return client.getChainId();
    },
    async getRecordServerSigner() {
      return client.readContract({
        address: config.gatewayAddress,
        abi: GATEWAY_ABI,
        functionName: 'recordServerSigner',
      });
    },
  };
}

import { getAddress } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import type { Address } from 'viem';
import type { GatewayReader } from './gateway.js';

/**
 * Raised when the deployment does not match the configuration.
 *
 * Messages name addresses and chain ids — public, on-chain facts — and never
 * the private key or the RPC URL, which can carry an API key.
 */
export class DeploymentVerificationError extends Error {
  constructor(message: string) {
    super(`Deployment verification failed: ${message}`);
    this.name = 'DeploymentVerificationError';
  }
}

export interface VerifyDeploymentParams {
  readonly reader: GatewayReader;
  /** Secret. Only its derived address is used or reported. */
  readonly recordServerPrivateKey: `0x${string}`;
  readonly expectedChainId: number;
}

export interface VerifiedDeployment {
  /** The address the gateway will accept attestations from. */
  readonly recordServerAddress: Address;
  readonly chainId: number;
}

/**
 * Confirm the server can actually produce attestations this gateway accepts.
 *
 * Two things can be misconfigured independently and both fail silently at
 * runtime: signing with a key the gateway does not recognize (every submission
 * reverts with "bad attestation signer"), and signing for the wrong chain (the
 * EIP-712 domain binds chainId, so every signature is rejected). Neither is
 * visible until a user tries to post a review, so both are checked at startup.
 *
 * The chain is checked first: a chain mismatch means the signer that was read
 * came from the wrong deployment, and reporting that as a signer mismatch would
 * point at the wrong fault.
 *
 * @throws DeploymentVerificationError on mismatch or an unreachable RPC.
 */
export async function verifyDeployment(
  params: VerifyDeploymentParams,
): Promise<VerifiedDeployment> {
  let expected: Address;
  try {
    expected = privateKeyToAddress(params.recordServerPrivateKey);
  } catch {
    // viem reports an out-of-range scalar by printing it as a decimal integer,
    // so its message is discarded rather than wrapped.
    throw new DeploymentVerificationError(
      'RECORD_SERVER_PRIVATE_KEY is not a valid secp256k1 private key',
    );
  }

  let chainId: number;
  try {
    chainId = await params.reader.getChainId();
  } catch {
    // The underlying error can contain the RPC URL.
    throw new DeploymentVerificationError('could not reach the configured RPC endpoint');
  }

  if (chainId !== params.expectedChainId) {
    throw new DeploymentVerificationError(
      `RPC endpoint serves chain ${chainId}, but CHAIN_ID is ${params.expectedChainId}`,
    );
  }

  let onChainSigner: Address;
  try {
    onChainSigner = await params.reader.getRecordServerSigner();
  } catch {
    throw new DeploymentVerificationError(
      'could not read recordServerSigner() from the configured ReviewGateway; ' +
        'check REVIEW_GATEWAY_ADDRESS points at a deployed gateway on this chain',
    );
  }

  // Checksum-safe: compare the canonical forms, not the raw strings.
  if (getAddress(onChainSigner) !== getAddress(expected)) {
    throw new DeploymentVerificationError(
      `ReviewGateway expects attestations from ${getAddress(onChainSigner)}, ` +
        `but RECORD_SERVER_PRIVATE_KEY derives ${getAddress(expected)}`,
    );
  }

  return { recordServerAddress: getAddress(expected), chainId };
}

import {
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  RawContractError,
  getAddress,
  hashTypedData,
  recoverTypedDataAddress,
} from 'viem';
import { getBlock, getCode, readContract } from 'viem/actions';
import type { Address, Hex, PublicClient } from 'viem';
import type { AuthorizationTypedData } from './reviewAuthorization.js';

/** `bytes4(keccak256("isValidSignature(bytes32,bytes)"))`, ERC-1271's accept value. */
export const ERC1271_MAGIC_VALUE = '0x1626ba7e';

/**
 * The 32-byte suffix an ERC-6492 signature ends with.
 *
 * Detected only so such a signature can be refused outright. ERC-6492 attests
 * to a wallet that does not exist yet, which is a weaker claim than a deployed
 * wallet's, and supporting it is deliberately out of scope.
 */
export const ERC6492_SUFFIX = '0x6492649264926492649264926492649264926492649264926492649264926492';

/**
 * Minimal ERC-1271 ABI.
 *
 * viem keeps its own `erc1271Abi` internal — it is not reachable from `viem` or
 * `viem/actions` — so the four lines are restated here rather than reached for
 * through a private path.
 */
const ERC1271_ABI = [
  {
    name: 'isValidSignature',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'hash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes4' }],
  },
] as const;

/**
 * The chain reads a contract-wallet check needs.
 *
 * A narrow interface rather than a viem client, matching `GatewayReader`, so
 * unit tests can drive every branch without a network. `createPublicClientReader`
 * is the only implementation that talks to an RPC.
 */
/**
 * Raised when the node describes a block without a number or a hash.
 *
 * Not a verdict about the signature; the caller turns it into
 * `verification_unavailable`.
 */
export class IncompleteBlockError extends Error {
  constructor() {
    super('Block response is missing a number or hash');
    this.name = 'IncompleteBlockError';
  }
}

/** A specific block, identified by hash as well as height. */
export interface VerificationBlock {
  readonly number: bigint;
  readonly hash: Hex;
}

export interface ContractWalletReader {
  /** The block to verify against: the head, or `blockNumber` when pinned. */
  getBlock(blockNumber?: bigint): Promise<VerificationBlock>;
  /** Deployed bytecode at `address`, or undefined/'0x' when there is none. */
  getCode(params: { address: Address; blockHash: Hex }): Promise<Hex | undefined>;
  /** Raw `isValidSignature` return value. */
  isValidSignature(params: {
    address: Address;
    hash: Hex;
    signature: Hex;
    blockHash: Hex;
  }): Promise<Hex>;
}

/**
 * A reader backed by a viem public client.
 *
 * Mirrors what viem's own (internal) `verifyErc1271` does — `readContract`
 * against `isValidSignature`, then compare the magic value — rather than
 * calling `publicClient.verifyTypedData`, whose default path wraps the
 * signature and routes through the ERC-6492 deployless validator.
 */
export function createPublicClientReader(client: PublicClient): ContractWalletReader {
  return {
    async getBlock(blockNumber) {
      const block = await getBlock(
        client,
        blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber },
      );

      // A pending block has a null number and hash. Substituting zeros would
      // pin both reads to a block that does not exist, so an incomplete
      // response is a failure to identify a block — which the caller reports as
      // verification being unavailable, never as a verdict.
      if (block.number === null || block.hash === null) {
        throw new IncompleteBlockError();
      }

      return { number: block.number, hash: block.hash };
    },
    async getCode(params) {
      // `requireCanonical` makes the node reject a block that has fallen out of
      // the canonical chain, rather than answering from an orphaned one.
      return getCode(client, {
        address: params.address,
        blockHash: params.blockHash,
        requireCanonical: true,
      });
    },
    async isValidSignature(params) {
      return readContract(client, {
        address: params.address,
        abi: ERC1271_ABI,
        functionName: 'isValidSignature',
        args: [params.hash, params.signature],
        blockHash: params.blockHash,
        requireCanonical: true,
      });
    },
  };
}

/** How the signature was accepted. */
export type WalletSignatureMethod = 'eoa' | 'erc1271';

export type WalletSignatureFailure =
  /** Could not be parsed or recovered from at all. */
  | 'malformed_signature'
  /** Recovered an address, but not the expected reviewer, and that reviewer is
   *  not a contract wallet that vouches for it. */
  | 'signer_mismatch'
  /** The contract wallet exists and declined the signature. */
  | 'invalid_contract_signature'
  /** The chain could not be read. Never treated as a pass. */
  | 'verification_unavailable'
  /** A counterfactual (ERC-6492) signature; out of scope. */
  | 'erc6492_unsupported';

export type WalletSignatureResult =
  | {
      readonly ok: true;
      readonly method: 'eoa';
    }
  | {
      readonly ok: true;
      readonly method: 'erc1271';
      /**
       * The exact block the wallet was asked at, by hash as well as height.
       *
       * ERC-1271 validity is a property of contract state, not of the
       * signature: a wallet may rotate its signers, so this result attests only
       * that the wallet accepted the signature at this block. It is not a claim
       * that it will later, nor that it did earlier.
       */
      readonly block: VerificationBlock;
    }
  | { readonly ok: false; readonly reason: WalletSignatureFailure };

export interface VerifyWalletSignatureParams {
  /** The address the signature must belong to — the World ID signal's wallet. */
  readonly expectedReviewer: Address;
  /** Built by `authorizationTypedData`; never reconstructed here. */
  readonly typedData: AuthorizationTypedData;
  readonly signature: Hex;
  /** Omit to verify EOA signatures only, with no chain access. */
  readonly reader?: ContractWalletReader;
  /**
   * Pin the contract-wallet check to a block height. Whether given or not, the
   * block is resolved once to a hash and both reads are pinned to that hash
   * with `requireCanonical`, so they see one identical block — a height alone
   * would still allow the two calls to land on different blocks at that height
   * if a reorg happened between them.
   */
  readonly blockNumber?: bigint;
}

/**
 * Verify that `expectedReviewer` authorized this exact typed data.
 *
 * Two paths, tried in order. EOA recovery first: it is exact, needs no network,
 * and covers almost every reviewer. Only if that fails to produce the expected
 * address is the chain consulted, and then only to ask whether
 * `expectedReviewer` is a deployed contract that vouches for the signature.
 *
 * The expected address is the subject of both paths, never an output of them —
 * the EOA branch compares the recovered address to it, and the ERC-1271 branch
 * calls `isValidSignature` *on it*. A signature some other wallet would accept
 * is not accepted here.
 *
 * An unreachable chain yields `verification_unavailable`. It is never silently
 * downgraded to a pass, and never to a plain rejection either: the caller must
 * be able to tell "this signature is wrong" from "we could not find out".
 */
export async function verifyWalletSignature(
  params: VerifyWalletSignatureParams,
): Promise<WalletSignatureResult> {
  const expected = getAddress(params.expectedReviewer);

  // The authorization must name the wallet we are checking. Recovering the
  // expected signer proves only who signed the document, not that the document
  // is about them: a signature by Bob over an authorization whose `reviewer` is
  // Alice would otherwise pass as "Bob authorized this". Checked first, so a
  // mismatch costs neither a recovery nor an RPC call.
  let signedReviewer: Address;
  try {
    signedReviewer = getAddress(params.typedData.message.reviewer);
  } catch {
    return { ok: false, reason: 'signer_mismatch' };
  }
  if (signedReviewer !== expected) {
    return { ok: false, reason: 'signer_mismatch' };
  }

  if (params.signature.toLowerCase().endsWith(ERC6492_SUFFIX.slice(2))) {
    return { ok: false, reason: 'erc6492_unsupported' };
  }

  const eoa = await recoverEoa(params.typedData, params.signature);
  if (eoa.recovered !== undefined && eoa.recovered === expected) {
    return { ok: true, method: 'eoa' };
  }

  // Nothing more can be checked without chain access.
  if (params.reader === undefined) {
    return {
      ok: false,
      reason: eoa.recovered === undefined ? 'malformed_signature' : 'signer_mismatch',
    };
  }

  return verifyContractWallet(params, expected, eoa.recovered !== undefined);
}

/** Recover the EOA signer, or report that the signature could not be parsed. */
async function recoverEoa(
  typedData: AuthorizationTypedData,
  signature: Hex,
): Promise<{ recovered: Address | undefined }> {
  try {
    const recovered = await recoverTypedDataAddress({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature,
    });
    return { recovered: getAddress(recovered) };
  } catch {
    // A smart-wallet signature is usually not 65 bytes, so failing to recover
    // is expected here and is not yet a rejection.
    return { recovered: undefined };
  }
}

/**
 * Decide whether a failed chain read means the wallet said no, or that we could
 * not find out.
 *
 * Classified by viem's error classes, walked through the wrapper chain with
 * `BaseError.walk` — never by matching message text, which changes between
 * versions and can embed the endpoint.
 *
 * Contract-level failures mean the call reached the wallet and did not produce
 * an acceptance: a revert, no returned data, or data that will not decode.
 * Those fail closed, as an invalid contract signature.
 *
 * Everything else — transport errors, timeouts, RPC-level faults, a
 * non-canonical block, and anything unrecognized — is infrastructure. Saying
 * "invalid" there would tell a reviewer their good signature was bad, so these
 * report that verification was unavailable instead.
 */
export function classifyContractReadError(err: unknown): WalletSignatureFailure {
  if (!(err instanceof BaseError)) return 'verification_unavailable';

  const contractLevel = err.walk(
    (cause) =>
      cause instanceof ContractFunctionRevertedError ||
      cause instanceof ContractFunctionZeroDataError ||
      cause instanceof RawContractError ||
      cause instanceof AbiDecodingZeroDataError ||
      cause instanceof AbiDecodingDataSizeTooSmallError,
  );

  return contractLevel === null ? 'verification_unavailable' : 'invalid_contract_signature';
}

async function verifyContractWallet(
  params: VerifyWalletSignatureParams,
  expected: Address,
  recoverable: boolean,
): Promise<WalletSignatureResult> {
  const reader = params.reader as ContractWalletReader;

  let block: VerificationBlock;
  let code: Hex | undefined;
  try {
    block = await reader.getBlock(params.blockNumber);
    code = await reader.getCode({ address: expected, blockHash: block.hash });
  } catch {
    // Resolving the block or reading bytecode is pure infrastructure: there is
    // no contract-level verdict to be had. The provider's error can name the
    // endpoint, so none of it is propagated.
    return { ok: false, reason: 'verification_unavailable' };
  }

  if (code === undefined || code === '0x') {
    // Not a contract, so the EOA result stands.
    return { ok: false, reason: recoverable ? 'signer_mismatch' : 'malformed_signature' };
  }

  // The digest the wallet is asked about is derived from the same typed data
  // the EOA path recovered against, so both paths judge one document.
  const hash = hashTypedData({
    domain: params.typedData.domain,
    types: params.typedData.types,
    primaryType: params.typedData.primaryType,
    message: params.typedData.message,
  });

  let returned: Hex;
  try {
    returned = await reader.isValidSignature({
      address: expected,
      hash,
      signature: params.signature,
      blockHash: block.hash,
    });
  } catch (err) {
    // A revert is the wallet declining; an outage is not. Conflating them would
    // report a provider failure as a bad signature.
    return { ok: false, reason: classifyContractReadError(err) };
  }

  return returned.toLowerCase().startsWith(ERC1271_MAGIC_VALUE)
    ? { ok: true, method: 'erc1271', block }
    : { ok: false, reason: 'invalid_contract_signature' };
}

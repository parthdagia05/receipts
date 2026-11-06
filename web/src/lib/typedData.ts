import type { Address, Hex, TypedDataDomain } from 'viem';
import type { SerializedAttestation, SerializedTypedData } from './api';

/**
 * Convert the Record Server's JSON typed data into what viem signs.
 *
 * JSON has no integer type wide enough for `uint256`, so the server renders
 * every integer as a decimal string. viem wants `bigint` for those fields, and
 * passing the string through would either throw or — worse — encode something
 * other than what the server will verify.
 *
 * The conversion is driven by the EIP-712 type definition, not by guessing
 * from the value: a field is converted precisely when its declared type is an
 * `int`/`uint` variant. That keeps `bytes32` and `address` fields as the hex
 * strings they must stay, and means a schema change cannot silently mangle a
 * field this function has never heard of.
 */

function isIntegerType(type: string): boolean {
  return /^u?int\d*$/.test(type);
}

export interface PreparedTypedData {
  readonly domain: TypedDataDomain;
  readonly types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

export function prepareTypedData(data: SerializedTypedData): PreparedTypedData {
  const fields = data.types[data.primaryType];
  if (fields === undefined) {
    throw new Error(
      `Typed data names primary type "${data.primaryType}", which it does not define`,
    );
  }

  const message: Record<string, unknown> = {};
  for (const field of fields) {
    const value = data.message[field.name];
    if (value === undefined) {
      throw new Error(`Typed data is missing the "${field.name}" field`);
    }
    message[field.name] =
      isIntegerType(field.type) && (typeof value === 'string' || typeof value === 'number')
        ? BigInt(value)
        : value;
  }

  // `chainId` is a uint256 in the EIP-712 domain but a number in viem's
  // domain type, and `verifyingContract` must survive as a hex address.
  const domain: TypedDataDomain = {
    ...(typeof data.domain['name'] === 'string' ? { name: data.domain['name'] } : {}),
    ...(typeof data.domain['version'] === 'string' ? { version: data.domain['version'] } : {}),
    ...(data.domain['chainId'] === undefined
      ? {}
      : { chainId: Number(data.domain['chainId'] as string | number) }),
    ...(typeof data.domain['verifyingContract'] === 'string'
      ? { verifyingContract: data.domain['verifyingContract'] as Address }
      : {}),
  };

  return { domain, types: data.types, primaryType: data.primaryType, message };
}

/** The attestation tuple as `submitFreeReview` expects it. */
export interface AttestationArgs {
  readonly agentId: bigint;
  readonly nullifier: Hex;
  readonly reviewer: Address;
  readonly expiry: bigint;
  readonly value: bigint;
  readonly valueDecimals: number;
  readonly feedbackHash: Hex;
  readonly feedbackURI: string;
  readonly reviewType: number;
  readonly receiptId: Hex;
  readonly signature: Hex;
}

/**
 * Widen the attestation's decimal strings back to integers for the call.
 *
 * Every field is passed through unchanged apart from that: the gateway
 * recovers the Record Server's signature over exactly these values, so
 * altering any of them — including re-checksumming an address — would make the
 * transaction revert with "bad attestation signer".
 */
export function toAttestationArgs(attestation: SerializedAttestation): AttestationArgs {
  return {
    agentId: BigInt(attestation.agentId),
    nullifier: attestation.nullifier,
    reviewer: attestation.reviewer,
    expiry: BigInt(attestation.expiry),
    value: BigInt(attestation.value),
    valueDecimals: attestation.valueDecimals,
    feedbackHash: attestation.feedbackHash,
    feedbackURI: attestation.feedbackURI,
    reviewType: attestation.reviewType,
    receiptId: attestation.receiptId,
    signature: attestation.signature,
  };
}

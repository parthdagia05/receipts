import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, TypedDataDomain } from 'viem';
import type { Env } from '../config/env.js';
import {
  ATTESTATION_TYPES,
  PRIMARY_TYPE,
  attestationDomain,
  validateAttestation,
} from './attestation.js';
import type { Attestation } from './attestation.js';

/**
 * Raised when the configured key is not a usable secp256k1 private key.
 *
 * The message is a fixed string. viem reports an out-of-range key by printing
 * it as a decimal integer, so its message is never propagated.
 */
export class InvalidPrivateKeyError extends Error {
  constructor(reason: string) {
    super(`Invalid record server private key: ${reason}`);
    this.name = 'InvalidPrivateKeyError';
  }
}

/** Raised when a produced signature would not satisfy the gateway's checks. */
export class SignatureIntegrityError extends Error {
  constructor(reason: string) {
    super(`Signature integrity check failed: ${reason}`);
    this.name = 'SignatureIntegrityError';
  }
}

/** secp256k1n / 2, matching the gateway's `_LOW_S_MAX`. */
const LOW_S_MAX = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export interface AttestationSignerConfig {
  /** Secret. 0x-prefixed 32-byte key; never stored on the returned object. */
  readonly privateKey: Hex;
  readonly chainId: number;
  readonly reviewGatewayAddress: Address;
}

export interface AttestationSigner {
  /** The signer's address. Must equal the gateway's `recordServerSigner`. */
  readonly address: Address;
  /** The EIP-712 domain these signatures are bound to. */
  readonly domain: TypedDataDomain;
  /** The EIP-712 digest the gateway will recover against. */
  hash(attestation: Attestation): Hex;
  /** Sign an attestation, returning a 65-byte signature. */
  sign(attestation: Attestation): Promise<Hex>;
  /** The address a signature recovers to. */
  recover(attestation: Attestation, signature: Hex): Promise<Address>;
  /** Whether `signature` over `attestation` came from this signer. */
  verify(attestation: Attestation, signature: Hex): Promise<boolean>;
}

/**
 * Reject anything that is not a 0x-prefixed 32-byte hex string.
 *
 * Checked before handing the value to viem so a malformed key is refused
 * without the value reaching a library that might echo it.
 */
function assertKeyFormat(privateKey: unknown): asserts privateKey is Hex {
  if (typeof privateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new InvalidPrivateKeyError('expected a 0x-prefixed 32-byte hex string');
  }
}

/**
 * Check the shape the gateway's `_recoverStrict` requires: exactly 65 bytes,
 * canonical `v`, and low-`s`.
 *
 * viem produces canonical signatures already, so this is an assertion rather
 * than a normalization — it fails loudly instead of emitting something the
 * gateway would reject on-chain.
 */
function assertGatewayCompatible(signature: Hex): void {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new SignatureIntegrityError('expected a 65-byte signature');
  }

  const s = BigInt(`0x${signature.slice(66, 130)}`);
  if (s > LOW_S_MAX) {
    throw new SignatureIntegrityError('s is not low; the gateway rejects malleable signatures');
  }

  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) {
    throw new SignatureIntegrityError(`v must be 27 or 28, got ${v}`);
  }
}

/**
 * Build the Record Server's attestation signer.
 *
 * The key is used to derive an account and is then reachable only through that
 * account's closure: it is not a property of the returned signer, so the signer
 * can be logged or serialized without leaking it.
 *
 * Every entry point validates the attestation first, so a malformed one is
 * refused before it can be hashed or signed. `sign`, `recover` and `verify`
 * then share one strict recovery path, so a signature that would fail on-chain
 * fails here instead — `sign` additionally checks its own output recovers to
 * this address.
 *
 * @throws InvalidPrivateKeyError when the key is malformed or out of range.
 */
export function createAttestationSigner(config: AttestationSignerConfig): AttestationSigner {
  assertKeyFormat(config.privateKey);

  let account;
  try {
    account = privateKeyToAccount(config.privateKey);
  } catch {
    // viem's message can contain the key as a decimal integer; discard it.
    throw new InvalidPrivateKeyError('not a valid secp256k1 scalar');
  }

  const domain = attestationDomain(config.chainId, config.reviewGatewayAddress);
  const address = account.address;

  const typedData = (attestation: Attestation) => ({
    domain,
    types: ATTESTATION_TYPES,
    primaryType: PRIMARY_TYPE,
    message: validateAttestation(attestation),
  });

  /**
   * Recover a signer, refusing any encoding the gateway would refuse.
   *
   * viem recovers the high-`s` twin of a signature to the same address, so
   * recovering through it alone would accept what `_recoverStrict` reverts on.
   * Every path that interprets a signature goes through here, which is what
   * keeps `sign`, `recover` and `verify` from disagreeing about what is valid.
   *
   * @throws SignatureIntegrityError when the encoding is not one the gateway
   *         accepts, before any recovery is attempted.
   */
  const recoverStrict = async (attestation: Attestation, signature: Hex): Promise<Address> => {
    assertGatewayCompatible(signature);
    return recoverTypedDataAddress({ ...typedData(attestation), signature });
  };

  return {
    address,
    domain,

    hash(attestation) {
      return hashTypedData(typedData(attestation));
    },

    async sign(attestation) {
      const signature = await account.signTypedData(typedData(attestation));

      const recovered = await recoverStrict(attestation, signature);
      if (recovered !== address) {
        throw new SignatureIntegrityError('signature does not recover to the signing address');
      }

      return signature;
    },

    async recover(attestation, signature) {
      return recoverStrict(attestation, signature);
    },

    async verify(attestation, signature) {
      try {
        return (await recoverStrict(attestation, signature)) === address;
      } catch {
        // A signature the gateway would reject, or one viem cannot read at all,
        // is a failed verification rather than an exception.
        return false;
      }
    },
  };
}

/** Build the signer from validated server configuration. */
export function createAttestationSignerFromEnv(env: Env): AttestationSigner {
  return createAttestationSigner({
    privateKey: env.recordServerPrivateKey,
    chainId: env.chainId,
    reviewGatewayAddress: env.reviewGatewayAddress,
  });
}

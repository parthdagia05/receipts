import { signRequest } from '@worldcoin/idkit-core/signing';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * The rp_context an IDKit request carries, in the field names IDKit expects.
 *
 * The SDK returns `sig`, `createdAt` and `expiresAt`; this is the wire form,
 * with `signature`, `created_at` and `expires_at`. Timestamps stay numbers
 * (unix seconds) exactly as the SDK produced them — reformatting them risks a
 * mismatch with the signed payload.
 */
export interface RpContext {
  readonly rp_id: string;
  readonly nonce: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly signature: string;
}

/**
 * Produces an rp_context for one action.
 *
 * A function type rather than a class so route tests can inject a deterministic
 * double: the real implementation draws a fresh random nonce per call, which
 * cannot be asserted against directly.
 */
export type RpContextSigner = (action: string) => RpContext;

/** Raised when the SDK cannot sign. Carries no key material. */
export class RpSigningError extends Error {
  constructor() {
    super('Failed to sign the World ID request');
    this.name = 'RpSigningError';
  }
}

/**
 * Raised when the configured RP signing key is unusable.
 *
 * Distinct from RpSigningError: this is a configuration fault surfaced at
 * startup, not a per-request failure. The message is a fixed string — viem
 * reports an out-of-range scalar by printing it as a decimal integer, so its
 * message is never relayed.
 */
export class RpSigningKeyError extends Error {
  constructor(reason: string) {
    super(`Invalid World ID RP signing key: ${reason}`);
    this.name = 'RpSigningKeyError';
  }
}

/**
 * Reject a key the SDK could not sign with, at construction time.
 *
 * `signRequest` signs over secp256k1, so the key must be a scalar in
 * [1, n). Validated with viem's `privateKeyToAccount`, which delegates the range
 * check to its audited curve implementation — no cryptography is written here.
 * Without this, a bad key would surface as a 500 on the first review request
 * rather than as a failure to boot.
 *
 * @throws RpSigningKeyError when the key is malformed or out of range.
 */
function assertValidSigningKey(signingKeyHex: string): void {
  const normalized = signingKeyHex.startsWith('0x') ? signingKeyHex : `0x${signingKeyHex}`;

  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new RpSigningKeyError('expected a 32-byte hex string');
  }

  try {
    privateKeyToAccount(normalized as `0x${string}`);
  } catch {
    throw new RpSigningKeyError('not a valid secp256k1 scalar');
  }
}

export interface RpContextSignerConfig {
  /** Secret. World Developer Portal RP signing key. */
  readonly signingKeyHex: string;
  /** The `rp_` identifier echoed back in the context. */
  readonly rpId: string;
  /** Request lifetime in seconds. The SDK defaults to 300. */
  readonly ttlSeconds?: number;
}

/**
 * Bind the RP signing key to a signer.
 *
 * The key stays in this closure: it is not a property of the returned function,
 * so nothing downstream can read it back. The SDK's own errors are discarded
 * and replaced with a fixed message — it rejects a malformed key by describing
 * it, and a server should not relay anything derived from key material.
 *
 * The key is validated here, so a misconfigured deployment fails at startup
 * instead of serving 500s.
 *
 * @throws RpSigningKeyError when the key is malformed or out of range.
 */
export function createRpContextSigner(config: RpContextSignerConfig): RpContextSigner {
  const { signingKeyHex, rpId, ttlSeconds } = config;

  assertValidSigningKey(signingKeyHex);

  return (action) => {
    let signed;
    try {
      signed = signRequest(
        ttlSeconds === undefined
          ? { signingKeyHex, action }
          : { signingKeyHex, action, ttl: ttlSeconds },
      );
    } catch {
      throw new RpSigningError();
    }

    return {
      rp_id: rpId,
      nonce: signed.nonce,
      created_at: signed.createdAt,
      expires_at: signed.expiresAt,
      signature: signed.sig,
    };
  };
}

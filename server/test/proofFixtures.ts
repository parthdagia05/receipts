import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { getAddress } from 'viem';

/** The reviewer the default fixtures bind their proof to. */
export const FIXTURE_REVIEWER = getAddress('0xabababababababababababababababababababab');

/** The nonce the default fixtures answer. */
export const FIXTURE_NONCE = `0x${'ab'.repeat(32)}`;

/**
 * A Proof of Human response item, shaped like the SDK's `ResponseItemV4`.
 *
 * `proof` is five decimal strings — four Groth16 elements plus the Merkle root —
 * and `nullifier` is decimal, both as the v4 schema specifies. Overriding a key
 * with `undefined` removes it, which is how the tests exercise missing fields.
 */
export function proofItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    identifier: 'proof_of_human',
    issuer_schema_id: 1,
    nullifier: '123456789012345678901234567890',
    proof: ['1', '2', '3', '4', '5'],
    expires_at_min: 1_793_740_842,
    signal_hash: hashSignal(FIXTURE_REVIEWER),
  };
  return applyOverrides(base, overrides);
}

/** A complete IDKit v4 uniqueness result, with `overrides` applied. */
export function idkitResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    protocol_version: '4.0',
    nonce: FIXTURE_NONCE,
    action: 'review-agent-42',
    environment: 'production',
    responses: [proofItem()],
  };
  return applyOverrides(base, overrides);
}

function applyOverrides(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

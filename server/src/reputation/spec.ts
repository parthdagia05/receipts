import { encodeAbiParameters, keccak256, toBytes } from 'viem';
import type { Address, Hex } from 'viem';

/**
 * Receipts Reputation — Specification v1.1 constants.
 *
 * Every number the scoring model depends on lives here and nowhere else, so
 * the approved specification can be read off one file and a change cannot be
 * made in the engine without being visible in a diff of this one.
 *
 * All weights are integers in MICRO-WEIGHT units (1 weight = 1_000_000).
 * The scale is chosen to equal USDC's own precision, which makes the paid
 * weight formula exact in integer arithmetic: a payment expressed in USDC's
 * 6-decimal base units divides by 10 to give micro-weight directly, with no
 * rescaling step that could lose a unit.
 *
 * Floating point is never used. A median is a comparison over a sorted list
 * and a weight is a sum; both are exact in bigint and neither is exact in
 * IEEE-754 once a tenth is involved.
 */

/** 1.0 weight, in micro-weight units. */
export const WEIGHT_ONE = 1_000_000n;

/** A free, human-verified review always counts exactly 1. */
export const FREE_WEIGHT = WEIGHT_ONE;

/**
 * A paid review counts `1 + min(paymentUSDC / 10, 1)`.
 *
 * `amount` arrives in USDC base units (6 decimals), so `amount / 10n` is
 * already micro-weight: 10 USDC = 10_000_000 base units / 10 = 1_000_000
 * micro-weight = +1.0, which is the cap. 1 USDC gives +0.1. Integer division
 * truncates below a micro-weight, which is deterministic and below any
 * resolution the score can express.
 */
export const PAID_BONUS_DIVISOR = 10n;

/** The bonus is capped at +1.0, so a paid review never exceeds 2.0. */
export const PAID_BONUS_CAP = WEIGHT_ONE;

/** Hard ceiling implied by the two constants above. Asserted in tests. */
export const MAX_PAID_WEIGHT = WEIGHT_ONE + PAID_BONUS_CAP;

/**
 * A score is not published below this many eligible, distinct humans.
 *
 * Distinctness is by World ID nullifier, which the on-chain NullifierRegistry
 * already enforces as one-per-(human, agent). The threshold is applied AFTER
 * every exclusion: a revoked or unattributable review is not an eligible
 * human, so it cannot help reach five.
 */
export const MIN_DISTINCT_HUMANS = 5;

/** Ratings are integers in this inclusive range; anything else is invalid. */
export const MIN_RATING = 0n;
export const MAX_RATING = 100n;

/** Receipts writes every entry with this exponent; a different one is invalid. */
export const REQUIRED_VALUE_DECIMALS = 0;

/** The gateway's fixed tags. tag2 is what distinguishes the two review types. */
export const TAG1_QUALITY = 'quality';
export const TAG2_FREE = 'human-verified';
export const TAG2_PAID = 'receipt-verified';
export const TAG2_WALLET = 'wallet-verified';

/** `reviewType` as the gateway encodes it on ReviewSubmitted. */
export const REVIEW_TYPE_FREE = 0;
export const REVIEW_TYPE_PAID = 1;
/**
 * Wallet-verified only: a signed challenge, NO World ID. Informational — it
 * never contributes to a score, a distinct-human count, a weight, or the
 * threshold. Types 0 and 1 are the only types that can score.
 */
export const REVIEW_TYPE_WALLET = 2;

/** Domain label hashed into every wallet-review nullifier. */
export const WALLET_NULLIFIER_DOMAIN_LABEL = 'ReceiptsWalletReview(v1)';

/**
 * The nullifier a wallet review carries on chain:
 * `keccak256(abi.encode(keccak256("ReceiptsWalletReview(v1)"), reviewer))`.
 *
 * Mirrors the wallet agent's gateway. It is derived from the reviewer address,
 * not from a World ID, which is exactly why a type-0/1 review carrying one is
 * rejected: it would be a wallet identity posing as a human.
 */
export function walletNullifier(reviewer: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }],
      [keccak256(toBytes(WALLET_NULLIFIER_DOMAIN_LABEL)), reviewer],
    ),
  );
}

/** Wallet reviews have no score, so no threshold applies. */
export const WALLET_TIER_THRESHOLD = 0;

/** Identifies the ruleset a published score and its evidence were produced by. */
export const SPEC_VERSION = 'receipts-reputation/1.1';

/** A payment amount that cannot be weighted. */
export class InvalidPaymentAmountError extends Error {
  constructor() {
    super('payment amount must not be negative');
    this.name = 'InvalidPaymentAmountError';
  }
}

/**
 * Compute the weight of a paid review from its settled amount.
 *
 * A negative amount throws rather than falling back to the free weight. USDC
 * cannot be negative, so the value did not come from a settled receipt, and
 * quietly scoring it as an ordinary free review would give unverifiable
 * evidence the same standing as verified evidence. The caller is expected to
 * have excluded it already; this is the backstop.
 *
 * @param amountBaseUnits USDC amount in 6-decimal base units.
 * @returns weight in micro-weight units, in [WEIGHT_ONE, MAX_PAID_WEIGHT].
 * @throws InvalidPaymentAmountError when the amount is negative.
 */
export function paidWeight(amountBaseUnits: bigint): bigint {
  if (amountBaseUnits < 0n) throw new InvalidPaymentAmountError();
  const bonus = amountBaseUnits / PAID_BONUS_DIVISOR;
  return WEIGHT_ONE + (bonus > PAID_BONUS_CAP ? PAID_BONUS_CAP : bonus);
}

/** Render micro-weight as a decimal string, for evidence and display. */
export function formatWeight(microWeight: bigint): string {
  const whole = microWeight / WEIGHT_ONE;
  const frac = (microWeight % WEIGHT_ONE).toString().padStart(6, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

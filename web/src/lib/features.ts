/**
 * Feature gating.
 *
 * Wallet-verified reviews are enabled by the server, not by a build-time
 * variable: the frontend asks `GET /api/reviews/wallet/status` and shows the
 * flow only on an explicit `enabled: true`. See `fetchWalletReviewsEnabled`.
 * This module only decides what the interface does with the answer.
 */

/** Which review methods the wizard offers. World ID is always offered. */
export function availableMethods(
  walletEnabled: boolean | null,
): readonly ('world_id' | 'wallet')[] {
  return walletEnabled === true ? ['world_id', 'wallet'] : ['world_id'];
}

import type { Hex } from 'viem';
import type {
  ConsumeAuthorizationResult,
  ReviewAuthorizationRecord,
} from './reviewAuthorizations.js';
import type { ReviewContentRecord } from './reviewContents.js';
import type {
  ConsumeWalletAuthorizationParams,
  ConsumeWalletAuthorizationResult,
  NewWalletReviewAuthorization,
  WalletReviewAuthorizationRecord,
} from './walletReviewAuthorizations.js';
import type { ConsumeFailure, WorldIdRequestRecord } from './worldIdRequests.js';
import type {
  RecordVerificationResult,
  WorldIdVerificationRecord,
} from './worldIdVerifications.js';

/**
 * The database operations the HTTP layer needs, as an async interface.
 *
 * Why this exists at all: `better-sqlite3` is synchronous and `pg` is not, so
 * the routes have to be async either way. Making that an explicit interface,
 * rather than changing the SQLite functions in place, buys three things:
 *
 *   - `concurrency.test.ts` keeps running against the SQLite implementation
 *     byte-for-byte unchanged, which is what the sprint requires.
 *   - The migration stays reversible: both drivers are present and either can
 *     be selected at startup until the PostgreSQL acceptance tests pass.
 *   - The two backends are forced to agree on a signature, so a behavioural
 *     difference shows up as a type error or a failing shared test rather
 *     than as a subtly different route response.
 *
 * Record shapes are imported from the existing SQLite modules deliberately.
 * They are the established contract with the routes; re-declaring them here
 * would create two definitions free to drift apart.
 */
export interface Repository {
  /** Backs `GET /health`. False rather than throwing when unreachable. */
  isReachable(): Promise<boolean>;

  // --- World ID requests --------------------------------------------------
  recordWorldIdRequest(params: {
    nonce: string;
    rpId: string;
    action: string;
    agentId: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void>;

  findWorldIdRequest(nonce: string): Promise<WorldIdRequestRecord | undefined>;

  checkWorldIdRequestUsable(params: {
    nonce: string;
    rpId: string;
    action: string;
    agentId: string;
    now: number;
  }): Promise<ConsumeFailure | undefined>;

  // --- Verifications ------------------------------------------------------
  consumeAndRecordVerification(params: {
    nonce: string;
    rpId: string;
    action: string;
    agentId: string;
    reviewer: string;
    nullifier: string;
    now: number;
  }): Promise<RecordVerificationResult>;

  findVerificationByNonce(nonce: string): Promise<WorldIdVerificationRecord | undefined>;

  // --- Authorizations -----------------------------------------------------
  createReviewAuthorization(
    nonce: Hex,
    params: {
      verificationNonce: string;
      agentId: string;
      reviewer: string;
      nullifier: Hex;
      value: number;
      valueDecimals: number;
      feedbackHash: Hex;
      reviewType: number;
      receiptId: Hex;
      deadline: number;
    },
    createdAt: number,
  ): Promise<void>;

  findReviewAuthorization(nonce: string): Promise<ReviewAuthorizationRecord | undefined>;

  consumeReviewAuthorization(params: {
    nonce: string;
    signature: Hex;
    now: number;
  }): Promise<ConsumeAuthorizationResult>;

  isVerificationAuthorized(verificationNonce: string): Promise<boolean>;

  // --- Wallet-verified review authorizations -------------------------------
  /**
   * @throws WalletAlreadyReviewedError when the wallet already has a spent
   *         review for the agent.
   */
  createWalletReviewAuthorization(
    nonce: Hex,
    params: NewWalletReviewAuthorization,
    createdAt: number,
  ): Promise<void>;

  findWalletReviewAuthorization(
    nonce: string,
  ): Promise<WalletReviewAuthorizationRecord | undefined>;

  consumeWalletReviewAuthorization(
    params: ConsumeWalletAuthorizationParams,
  ): Promise<ConsumeWalletAuthorizationResult>;

  /** Whether this wallet already has a spent wallet review for the agent. */
  isWalletReviewed(agentId: string, reviewer: string): Promise<boolean>;

  // --- Review content -----------------------------------------------------
  putReviewContent(params: { content: Uint8Array; createdAt: number }): Promise<void>;

  findReviewContent(feedbackHash: string): Promise<ReviewContentRecord | null>;

  /** Releases connections. Called from the SIGTERM handler. */
  close(): Promise<void>;
}

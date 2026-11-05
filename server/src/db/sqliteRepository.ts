import type { Hex } from 'viem';
import type { Db } from './index.js';
import { isDatabaseReachable } from './index.js';
import {
  consumeReviewAuthorization,
  createReviewAuthorization,
  findReviewAuthorization,
  isVerificationAuthorized,
} from './reviewAuthorizations.js';
import { findReviewContent, putReviewContent } from './reviewContents.js';
import {
  consumeWalletReviewAuthorization,
  createWalletReviewAuthorization,
  findWalletReviewAuthorization,
  isWalletReviewed,
} from './walletReviewAuthorizations.js';
import {
  checkWorldIdRequestUsable,
  findWorldIdRequest,
  recordWorldIdRequest,
} from './worldIdRequests.js';
import { consumeAndRecordVerification, findVerificationByNonce } from './worldIdVerifications.js';
import type { Repository } from './repository.js';

/**
 * The SQLite implementation: thin async wrappers over the existing functions.
 *
 * Deliberately a wrapper and not a rewrite. The functions underneath are
 * unchanged, which is what lets `concurrency.test.ts` and its worker threads
 * keep exercising them directly, byte-for-byte as written. Their transaction
 * semantics — `BEGIN IMMEDIATE`, the rollback classification, the idempotent
 * replay — are the behaviour this migration has to reproduce elsewhere, so
 * they are left exactly where they are until PostgreSQL has been shown to
 * match them.
 *
 * Every method is `async` despite the work being synchronous. The interface
 * is async because `pg` is; promising it here costs a microtask and keeps the
 * two implementations substitutable.
 */
export function createSqliteRepository(db: Db): Repository {
  return {
    async isReachable() {
      return isDatabaseReachable(db);
    },

    async recordWorldIdRequest(params) {
      recordWorldIdRequest(db, params);
    },

    async findWorldIdRequest(nonce) {
      return findWorldIdRequest(db, nonce);
    },

    async checkWorldIdRequestUsable(params) {
      return checkWorldIdRequestUsable(db, params);
    },

    async consumeAndRecordVerification(params) {
      return consumeAndRecordVerification(db, params);
    },

    async findVerificationByNonce(nonce) {
      return findVerificationByNonce(db, nonce);
    },

    async createReviewAuthorization(nonce: Hex, params, createdAt) {
      createReviewAuthorization(db, nonce, params, createdAt);
    },

    async findReviewAuthorization(nonce) {
      return findReviewAuthorization(db, nonce);
    },


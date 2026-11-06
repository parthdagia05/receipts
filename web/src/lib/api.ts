import type { Address, Hex } from 'viem';
import { config } from './config';

/**
 * Typed client for the Record Server.
 *
 * Every shape here mirrors a response interface that already exists on the
 * server — `WorldIdRequestResponse`, `ReviewProofResponse`,
 * `ReviewPrepareResponse`, `ReviewAttestResponse`, `HealthResponse`. The
 * frontend adds no endpoints and reshapes nothing: the server decides what a
 * review is, and this file only carries it across the wire.
 *
 * Errors arrive as `{ error: string }` with an optional human-readable
 * `message`. They are surfaced as `ApiError` so a caller can branch on the
 * stable `error` code rather than parsing prose.
 */

export class ApiError extends Error {
  readonly status: number;
  /** The server's stable error code, e.g. `already_reviewed`. */
  readonly code: string;
  /** Field-level detail from `prepare`, when it rejects review content. */
  readonly issues: readonly { readonly field: string; readonly message: string }[] | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    issues?: readonly { readonly field: string; readonly message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

/** A failure to reach the server at all, as opposed to a rejection by it. */
export class ApiUnreachableError extends Error {
  constructor() {
    super('Could not reach the Record Server.');
    this.name = 'ApiUnreachableError';
  }
}

/**
 * Human-readable text for the error codes a user can actually provoke.
 *
 * Codes absent from this map fall back to the server's own `message`, then to
 * the raw code. The goal is that no screen ever shows a bare snake_case token
 * for a situation the user could reasonably hit.
 */
const ERROR_COPY: Readonly<Record<string, string>> = {
  already_reviewed: 'This World ID has already reviewed this agent.',
  request_already_used: 'That verification has already been used.',
  request_expired: 'The verification request expired. Start again.',
  unknown_request: 'The server does not recognise that verification request.',
  challenge_expired: 'The signing window closed. Please restart the review.',
  wallet_already_reviewed: 'This wallet has already reviewed this agent.',
  nonce_consumed: 'That signing challenge was already used. Please restart the review.',
  wallet_reviews_disabled: 'Wallet-verified reviews are not available right now.',
  unknown_challenge: 'The server does not recognise that signing challenge.',
  signature_conflict: 'This challenge was already signed with a different signature.',
  invalid_wallet_signature: 'That signature does not match the connected wallet.',
  verification_already_authorized: 'This verification has already been used for a review.',
  environment_mismatch:
    'The World ID proof came from a different environment than the server expects.',
  action_mismatch: 'The World ID proof was scoped to a different agent.',
  signal_mismatch: 'The World ID proof is not bound to the connected wallet.',
  missing_proof_of_human: 'The proof did not include a Proof of Human credential.',
  proof_of_human_not_verified: 'World ID could not verify the Proof of Human credential.',
  proof_rejected: 'World ID rejected the proof.',
  verification_unavailable: 'World ID is unreachable right now. Try again shortly.',
  signature_verification_unavailable: 'Signature verification is temporarily unavailable.',
  content_too_large: 'That review is too long.',
  invalid_review_content: 'The review content was rejected.',
};

export function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    return ERROR_COPY[error.code] ?? error.message ?? error.code;
  }
  if (error instanceof ApiUnreachableError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new ApiUnreachableError();
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.ok)
      throw new ApiError(response.status, 'malformed_response', 'Malformed response.');
    throw new ApiError(response.status, 'http_error', `Request failed (${response.status}).`);
  }

  if (!response.ok) {
    const record = (body ?? {}) as Record<string, unknown>;
    const code = typeof record['error'] === 'string' ? record['error'] : 'http_error';
    const message =
      typeof record['message'] === 'string'
        ? record['message']
        : `Request failed (${response.status}).`;
    const issues = Array.isArray(record['issues'])
      ? (record['issues'] as { field: string; message: string }[])
      : undefined;
    throw new ApiError(response.status, code, message, issues);
  }

  return body as T;
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(payload) });
}

/* --- Health -------------------------------------------------------------- */

export interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly uptimeSeconds: number;
  readonly checks: { readonly database: 'ok' | 'unreachable' };
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health');
}

/* --- Step 2: World ID ---------------------------------------------------- */

export interface RpContext {
  readonly rp_id: string;
  readonly nonce: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly signature: string;
}

export interface WorldIdRequestResponse {
  readonly app_id: string;
  readonly action: string;
  readonly rp_context: RpContext;
  /**
   * Which World environment to open the request against, chosen by the server.
   *
   * The browser relays this to IDKit; it never decides it. The server checks
   * the environment carried inside the returned proof against its own
   * configuration, so this value steers where the request goes and has no say
   * in whether the result is accepted.
   */
  readonly environment: 'production' | 'staging' | 'sandbox';
}

/** Mint an RP-signed World ID request. The action is derived server-side. */
export function requestWorldId(agentId: string): Promise<WorldIdRequestResponse> {
  return post<WorldIdRequestResponse>('/api/world-id/request', { agentId });
}

export interface ReviewProofResponse {
  readonly agent_id: string;
  readonly reviewer: string;
  readonly nullifier: string;
  readonly verified_at: number;
}

/** Submit the IDKit result for verification. The proof is forwarded unchanged. */
export function verifyProof(input: {
  agentId: string;
  reviewer: Address;
  proof: unknown;
}): Promise<ReviewProofResponse> {
  return post<ReviewProofResponse>('/api/reviews/verify', input);
}

/* --- Step 3/4: prepare and sign ------------------------------------------ */

/** EIP-712 typed data with integers serialised as decimal strings. */
export interface SerializedTypedData {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

export interface ReviewPrepareResponse {
  readonly challenge_id: Hex;
  readonly deadline: number;
  readonly feedback_hash: Hex;
  readonly typed_data: SerializedTypedData;
  /** Present on wallet challenges only: `2` and `wallet_only`. */
  readonly review_type?: number;
  readonly verification?: string;
}

/**
 * Turn a verified proof plus review text into typed data for the wallet.
 *
 * `feedbackHash` is computed by the server from `content`; it is deliberately
 * not sent. `requestNonce` names the exact World ID verification being spent.
 */
export function prepareReview(input: {
  agentId: string;
  reviewer: Address;
  value: number;
  valueDecimals: number;
  reviewType: number;
  content: string;
  requestNonce: string;
}): Promise<ReviewPrepareResponse> {
  return post<ReviewPrepareResponse>('/api/reviews/prepare', input);
}

/* --- Wallet-verified reviews --------------------------------------------- */

/**
 * Whether the server currently accepts wallet-verified reviews.
 *
 * Fails closed: any error, malformed body or non-`true` value means disabled,
 * so the wallet flow is only ever shown when the server says it will answer.
 */
export async function fetchWalletReviewsEnabled(): Promise<boolean> {
  try {
    const body = await request<{ enabled?: unknown }>('/api/reviews/wallet/status');
    return body.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Prepare a wallet-verified review.
 *
 * Deliberately carries no `reviewType`, `receiptId`, `nullifier` or
 * `requestNonce`: the server fixes the type, derives the nullifier from the
 * reviewer address and hashes the content itself.
 */
export function prepareWalletReview(input: {
  agentId: string;
  reviewer: Address;
  value: number;
  valueDecimals: number;
  content: string;
}): Promise<ReviewPrepareResponse> {
  return post<ReviewPrepareResponse>('/api/reviews/wallet/prepare', {
    agentId: input.agentId,
    reviewer: input.reviewer,
    value: input.value,
    valueDecimals: input.valueDecimals,
    content: input.content,
  });
}

export interface SerializedAttestation {
  readonly agentId: string;
  readonly nullifier: Hex;
  readonly reviewer: Address;
  readonly expiry: string;
  readonly value: string;
  readonly valueDecimals: number;
  readonly feedbackHash: Hex;
  readonly feedbackURI: string;
  readonly reviewType: number;
  readonly receiptId: Hex;
  readonly signature: Hex;
}

/** Every gateway entry point the server may name. */
export const SUBMIT_FUNCTIONS = [
  'submitFreeReview',
  'submitPaidReview',
  'submitWalletReview',
] as const;
export type SubmitFunction = (typeof SUBMIT_FUNCTIONS)[number];

/**
 * Validate the `submit_function` a server named.
 *
 * Throws on anything unrecognised so the caller lands in its error state
 * instead of sending a transaction to a function it does not understand.
 */
export function parseSubmitFunction(value: unknown): SubmitFunction {
  const match = SUBMIT_FUNCTIONS.find((name) => name === value);
  if (match === undefined) {
    throw new ApiError(
      502,
      'unknown_submit_function',
      'The server asked for a gateway function this app does not support.',
    );
  }
  return match;
}

export interface ReviewAttestResponse {
  readonly attestation: SerializedAttestation;
  readonly gateway: Address;
  /** Typed as a string on the wire; run it through `parseSubmitFunction`. */
  readonly submit_function: string;
  /** Always false — this endpoint signs, it does not send a transaction. */
  readonly submitted: false;
}


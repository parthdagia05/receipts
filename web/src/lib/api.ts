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

/** Exchange the signed challenge for a Record Server attestation. */
export function attestReview(input: {
  challengeId: Hex;
  signature: Hex;
}): Promise<ReviewAttestResponse> {
  return post<ReviewAttestResponse>('/api/reviews/attest', input);
}

/* --- Published review content -------------------------------------------- */

/**
 * Fetch the text a review's `feedbackHash` commits to.
 *
 * Returns null for anything the server does not hold, which is the normal
 * answer for a review whose content was written by a different deployment.
 */
export async function fetchReviewContent(feedbackHash: string): Promise<string | null> {
  try {
    const response = await fetch(`${config.apiBaseUrl}/reviews/${feedbackHash}`);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/* --- Receipts reputation -------------------------------------------------- */

export interface ReputationEvidence {
  readonly spec: string;
  readonly agentId: string;
  readonly chainId: number;
  readonly snapshotBlock: string;
  readonly contracts: Record<string, string>;
  readonly status: string;
  readonly score: string | null;
  readonly threshold: number;
  readonly distinctHumans: number;
  readonly humanVerifiedCount: number;
  readonly receiptVerifiedCount: number;
  readonly totalWeight: string;
  readonly eligible: readonly {
    readonly nullifier: string;
    readonly value: string;
    readonly reviewType: number;
    readonly weight: string;
    readonly weightDecimal: string;
    readonly feedbackIndex: string;
  }[];
  readonly excluded: readonly {
    readonly nullifier: string;
    readonly feedbackIndex: string;
    readonly reason: string;
  }[];
  /** On-chain records the server could not attribute to a review. Hashed. */
  readonly unattributable: readonly { readonly detail: string }[];
}

export interface ReputationResponse {
  readonly agent_id: string;
  readonly status: 'published' | 'below_threshold' | 'no_eligible_reviews';
  /** The weighted median. Null until the distinct-human threshold is met. */
  readonly score: number | null;
  readonly threshold: number;
  readonly distinct_humans: number;
  readonly human_verified: number;
  readonly receipt_verified: number;
  readonly total_weight: string;
  readonly snapshot_block: string;
  readonly evidence_hash: Hex;
  readonly evidence: ReputationEvidence;
  readonly unattributable: readonly { readonly detail: string }[];
  /**
   * Per-assurance breakdown. Additive and optional: a server that predates it
   * omits the field, and the top-level fields above stay authoritative.
   * `unknown` because it is normalised by `readTiers` before use.
   */
  readonly tiers?: unknown;
}

/**
 * The Receipts weighted-median score and the evidence behind it.
 *
 * Computed server-side from on-chain data, not from anything this client
 * supplies. Distinct from the ERC-8004 registry mean, which is read directly
 * from the chain elsewhere and is a different number with different
 * properties.
 */
export function fetchReputation(agentId: string): Promise<ReputationResponse> {
  return request<ReputationResponse>(`/api/agents/${agentId}/reputation`);
}

/* --- Simulation (demo only) ----------------------------------------------- */

export interface SimulatedReputation {
  /** Always true. Guards against this ever being read as a live score. */
  readonly simulated: true;
  readonly status: 'published' | 'below_threshold' | 'no_eligible_reviews';
  readonly score: number | null;
  /** The plain average, for comparison. What ERC-8004's getSummary returns. */
  readonly unweighted_mean: number | null;
  readonly threshold: number;
  readonly distinct_humans: number;
  readonly human_verified: number;
  readonly receipt_verified: number;
  readonly total_weight: string;
  readonly eligible: readonly {
    readonly value: number;
    readonly reviewType: number;
    readonly weight: string;
  }[];
  readonly excluded: readonly { readonly reason: string }[];
}

export interface SimulatedReviewInput {
  readonly value: number;
  readonly reviewType: number;
  readonly paymentAmount?: string;
  readonly revoked?: boolean;
}

/**
 * Score invented reviews with the real engine.
 *
 * Separate endpoint, separate type, and the response is marked `simulated`.
 * Nothing here touches chain state or the live reputation of any agent.
 */
export function simulateReputation(
  reviews: readonly SimulatedReviewInput[],
): Promise<SimulatedReputation> {
  return post<SimulatedReputation>('/api/reputation/simulate', { reviews });
}

/** One scoring rule's tally across the gauntlet's trials. */
export interface GauntletSide {
  /** Attacked score moved >= success_threshold points (or was minted). */
  readonly corrupted: number;
  readonly protected: number;
  /** Published nothing: under the five-distinct-human floor. Not a defense. */
  readonly withheld: number;
  readonly corrupted_below_half_weight: number;
  /** Attacked score left the honest rating range entirely. */
  readonly escaped: number;
  readonly escaped_below_half_weight: number;
}

export interface GauntletResponse {
  /** Always true. Nothing in the gauntlet touches a chain. */
  readonly simulated: true;
  readonly trials: number;
  readonly seed: number;
  readonly success_threshold: number;
  /** Trials where attackers held under half the weight. */
  readonly minority_trials: number;
  readonly generator: {
    readonly honest_min: number;
    readonly honest_max: number;
    readonly honest_rating_min: number;
    readonly honest_rating_max: number;
    readonly attackers_min: number;
    readonly attackers_max: number;
    readonly attack_ratings: readonly number[];
  };
  readonly mean: GauntletSide;
  readonly median: GauntletSide;
}

/**
 * Run the Monte Carlo attack gauntlet server-side.
 *
 * Every trial is scored by the production engine. Deterministic for a given
 * seed, so a result shown in a demo can be reproduced by anyone.
 */
export function runAttackGauntlet(input?: {
  trials?: number;
  seed?: number;
}): Promise<GauntletResponse> {
  return post<GauntletResponse>('/api/reputation/simulate/gauntlet', input ?? {});
}

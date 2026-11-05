import type { IDKitResultV4Payload } from './proof.js';

/**
 * One entry of the API's `results` array.
 *
 * Every field is optional in the published schema, so nothing here may be
 * assumed present.
 */
export interface VerifyResultItem {
  readonly identifier?: string;
  readonly success?: boolean;
  readonly nullifier?: string;
  readonly code?: string;
  readonly detail?: string;
}

/**
 * A 200 response from `POST /api/v4/verify/{rp_id}`.
 *
 * Only `success` and `results` are required. `action`, `nullifier`,
 * `environment` and the rest are optional, so a check that depends on them must
 * treat absence explicitly rather than as a pass.
 */
export interface VerifySuccessResponse {
  readonly success: true;
  readonly results: readonly VerifyResultItem[];
  readonly action?: string;
  readonly nullifier?: string;
  readonly environment?: string;
  readonly created_at?: string;
  readonly session_id?: string;
  readonly message?: string;
}

/** What the client reports back. Never carries a provider error verbatim. */
export type VerifyOutcome =
  | { readonly ok: true; readonly response: VerifySuccessResponse }
  | { readonly ok: false; readonly failure: VerifyFailure };

export type VerifyFailure =
  /** Non-2xx. `code` is the API's opaque error code when it supplied one. */
  | { readonly kind: 'rejected'; readonly status: number; readonly code?: string }
  /** Timed out or the request never completed. */
  | { readonly kind: 'unavailable' }
  /** 2xx whose body was not valid JSON, or not the documented success shape. */
  | { readonly kind: 'malformed' };

/**
 * Submits a proof to the World ID Developer Portal.
 *
 * A function type so route tests can inject deterministic outcomes instead of
 * reaching the network.
 */
export type WorldIdVerifier = (result: IDKitResultV4Payload) => Promise<VerifyOutcome>;

export const DEFAULT_VERIFY_BASE_URL = 'https://developer.world.org';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface WorldIdVerifierConfig {
  /** The `rp_` identifier; the endpoint's path segment. */
  readonly rpId: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Whether `value` is the documented 200 body. */
function isSuccessResponse(value: unknown): value is VerifySuccessResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;

  // `success` is `enum: [true]` and `results` is required.
  if (body['success'] !== true) return false;
  if (!Array.isArray(body['results'])) return false;

  return body['results'].every(
    (item) => typeof item === 'object' && item !== null && !Array.isArray(item),
  );
}

/** The API's `code`, when the error body carries one. */
function errorCodeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const code = (body as Record<string, unknown>)['code'];
  return typeof code === 'string' ? code : undefined;
}

/**
 * Build a verifier bound to one RP.
 *
 * The whole IDKit result is forwarded unchanged, as the migration guide
 * requires: its type matches the request schema field-for-field, and remapping
 * it is how a v4 payload gets mistaken for a legacy one.
 *
 * Failures are classified into three kinds and nothing else is propagated. The
 * provider's message can quote the request — proof elements and the nullifier
 * among them — so it is never attached to the outcome.
 */
export function createWorldIdVerifier(config: WorldIdVerifierConfig): WorldIdVerifier {
  const baseUrl = config.baseUrl ?? DEFAULT_VERIFY_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = config.fetchImpl ?? fetch;
  const url = `${baseUrl}/api/v4/verify/${config.rpId}`;

  return async (result) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    // The timer is cleared once, after the body has been read. Clearing it when
    // the headers arrive would leave a response that streams its body slowly
    // able to hold the request open indefinitely — the timeout has to cover the
    // whole exchange, not just the connection.
    try {
      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(result),
          signal: controller.signal,
        });
      } catch {
        // Abort, DNS, TLS, connection reset — all indistinguishable to a caller,
        // and the underlying message can name the endpoint.
        return { ok: false, failure: { kind: 'unavailable' } };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        // A body that never finished arriving is a transport failure, not a
        // malformed document, so the two are told apart by the signal rather
        // than by the parse error.
        if (controller.signal.aborted) {
          return { ok: false, failure: { kind: 'unavailable' } };
        }
        return response.ok
          ? { ok: false, failure: { kind: 'malformed' } }
          : { ok: false, failure: { kind: 'rejected', status: response.status } };
      }

      if (!response.ok) {
        const code = errorCodeOf(body);
        return {
          ok: false,
          failure: {
            kind: 'rejected',
            status: response.status,
            ...(code === undefined ? {} : { code }),
          },
        };
      }

      if (!isSuccessResponse(body)) {
        // A 2xx that does not match the documented shape is not a pass.
        return { ok: false, failure: { kind: 'malformed' } };
      }

      return { ok: true, response: body };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The result entry for `identifier` that actually verified.
 *
 * The endpoint returns 200 for "at least one proof verified successfully", so a
 * 200 alone says nothing about the credential this server requires. Only an
 * entry whose identifier matches and whose `success` is exactly true counts.
 */
export function findVerifiedResult(
  response: VerifySuccessResponse,
  identifier: string,
): VerifyResultItem | undefined {
  return response.results.find((item) => item.identifier === identifier && item.success === true);
}

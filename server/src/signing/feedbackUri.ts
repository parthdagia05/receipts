import type { Hex } from 'viem';

/**
 * Where a review's evidence is published, derived rather than supplied.
 *
 * The URI is a pure function of `feedbackHash`, which the human already signed
 * in the wallet authorization. That is what makes it safe to leave out of the
 * authorization schema: there is no separate value for the server, a relayer or
 * anyone else to substitute, because any URI that does not end in the signed
 * hash is a different URI and so a different attestation digest.
 *
 * Accepting a client-supplied URI instead would have required binding it into
 * the authorization as well, or the substitution F-01 describes would simply
 * have moved from the submitter to this server.
 */

/** Path segment under the base URL where review content is served. Exported so
 *  the retrieval route mounts at the same place the signed URI points to. */
export const REVIEW_PATH = 'reviews';

/**
 * Check and canonicalize a configured base URL.
 *
 * The derived URI is string-concatenated onto this value and then signed, so
 * anything the base carries beyond scheme, host and path would end up in the
 * wrong place: a query string or fragment would swallow the hash that follows
 * it (`https://h/?x=1/reviews/0x…` names no review), and embedded credentials
 * would be published inside every attestation. Each is rejected rather than
 * stripped, because silently rewriting an operator's URL would change every
 * digest the server produces without telling anyone.
 *
 * A trailing slash is the one thing normalized away — `https://h/` and
 * `https://h` mean the same origin, and only one of them concatenates cleanly.
 *
 * @returns the canonical base, or null when the value is unusable.
 */
export function normalizeReviewContentBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.search !== '') return null;
  if (url.hash !== '') return null;
  if (url.hostname === '') return null;

  // A bare origin only. The retrieval route is mounted at `/<REVIEW_PATH>/:hash`,
  // so a base carrying its own path prefix would sign URIs the server does not
  // answer — and a dead URI is discovered only after it is already on-chain and
  // unchangeable. Rejecting at startup is the cheap moment to catch it. Deploy
  // behind a prefix by stripping it in the proxy, not by encoding it here.
  if (url.pathname.replace(/\/+$/, '') !== '') return null;

  return `${url.protocol}//${url.host}`;
}

/**
 * Build the canonical evidence URI for a content hash.
 *
 * @param baseUrl Origin (and optional prefix) the content is served from,
 *        already canonical per `normalizeReviewContentBaseUrl`. A trailing
 *        slash is tolerated and normalized away here too, so a caller that
 *        skipped validation still cannot produce a doubled separator.
 * @param feedbackHash The 0x-prefixed keccak256 of the review content.
 */
export function feedbackUriFor(baseUrl: string, feedbackHash: Hex): string {
  return `${baseUrl.replace(/\/+$/, '')}/${REVIEW_PATH}/${feedbackHash}`;
}

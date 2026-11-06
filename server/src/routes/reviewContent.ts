import { Hono } from 'hono';
import type { Repository } from '../db/repository.js';
import { REVIEW_PATH } from '../signing/feedbackUri.js';

export interface ReviewContentDeps {
  readonly repo: Repository;
}

const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * `GET /reviews/:feedbackHash` — serve the content a review's `feedbackHash`
 * commits to.
 *
 * This is the other half of the signed `feedbackURI`: the attestation carries
 * `<base>/reviews/<feedbackHash>`, and this route is what that resolves to. The
 * path is built from the same `REVIEW_PATH` constant the URI derivation uses,
 * so the two cannot drift apart.
 *
 * Public and unauthenticated by design — review text is published data, and the
 * whole point of the URI is that anyone can fetch it and check the hash.
 *
 * The response body is the stored byte string verbatim. It is never re-encoded
 * or re-serialized, because a reader's only guarantee is that keccak256 of what
 * it receives equals the hash it asked for.
 */
export function reviewContentRoute(deps: ReviewContentDeps): Hono {
  const app = new Hono();

  app.get(`/${REVIEW_PATH}/:feedbackHash`, async (c) => {
    const feedbackHash = c.req.param('feedbackHash');

    // A malformed key cannot name a stored row, so it is a 404 rather than a
    // 400: this is a content-addressed namespace, and "not a hash" and "not a
    // hash I hold" are the same answer to a fetcher.
    if (!BYTES32_PATTERN.test(feedbackHash)) {
      return c.json({ error: 'not_found' }, 404);
    }

    const record = await deps.repo.findReviewContent(feedbackHash);
    if (record === null) {
      return c.json({ error: 'not_found' }, 404);
    }

    // Content-addressed, so the bytes under this URL can never change.
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    // Nothing here is HTML, and a browser must not be talked into treating
    // reviewer-authored text as a document on this origin.
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Disposition', 'inline');

    return c.body(record.content as unknown as ArrayBuffer, 200);
  });

  return app;
}

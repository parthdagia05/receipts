import { beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import type { Hex } from 'viem';
import { openDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { createSqliteRepository } from '../src/db/sqliteRepository.js';
import type { Db } from '../src/db/index.js';
import {
  InvalidReviewContentError,
  findReviewContent,
  putReviewContent,
} from '../src/db/reviewContents.js';
import { reviewContentRoute } from '../src/routes/reviewContent.js';
import {
  REVIEW_PATH,
  feedbackUriFor,
  normalizeReviewContentBaseUrl,
} from '../src/signing/feedbackUri.js';

/**
 * The retrieval half of the signed `feedbackURI`.
 *
 * The attestation commits to `<base>/reviews/<feedbackHash>`. These tests hold
 * the one property a reader depends on: whatever those bytes are, keccak256 of
 * them equals the hash in the URL they were fetched from.
 */
describe('review content retrieval', () => {
  const CONTENT = 'Settled the refund without being asked twice.';
  const BASE = 'https://receipts.example';

  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
  });

  const app = () => reviewContentRoute({ repo: createSqliteRepository(db) });

  /** Fetch through the derived URI, exactly as a reader would. */
  const getByUri = (uri: string) => app().request(new URL(uri).pathname);

  describe('the derived URI resolves', () => {
    it('serves content stored through the prepare path', async () => {
      const bytes = toBytes(CONTENT);
      const { feedbackHash } = putReviewContent(db, { content: bytes, createdAt: 1_700_000_000 });

      const res = await getByUri(feedbackUriFor(BASE, feedbackHash));

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(CONTENT);
    });

    it('mounts where the signed URI points', () => {
      const uri = feedbackUriFor(BASE, keccak256(toBytes(CONTENT)));

      // The URI and the route are built from the same constant; this pins the
      // literal shape so a rename cannot quietly move one without the other.
      expect(uri).toBe(`${BASE}/${REVIEW_PATH}/${keccak256(toBytes(CONTENT))}`);
      expect(new URL(uri).pathname).toBe(`/${REVIEW_PATH}/${keccak256(toBytes(CONTENT))}`);
    });

    it('declares a type that cannot be sniffed into a document', async () => {
      const { feedbackHash } = putReviewContent(db, {
        content: toBytes(CONTENT),
        createdAt: 1_700_000_000,
      });

      const res = await getByUri(feedbackUriFor(BASE, feedbackHash));

      expect(res.headers.get('content-type')?.toLowerCase()).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });
  });

  describe('the bytes served reproduce the hash', () => {
    it('round-trips to the same feedbackHash', async () => {
      const bytes = toBytes(CONTENT);
      const expected = keccak256(bytes);
      const { feedbackHash } = putReviewContent(db, { content: bytes, createdAt: 1_700_000_000 });
      expect(feedbackHash).toBe(expected);

      const res = await getByUri(feedbackUriFor(BASE, feedbackHash));
      const served = new Uint8Array(await res.arrayBuffer());

      // The check a consumer performs before trusting the review text.
      expect(keccak256(served)).toBe(feedbackHash);
      expect(served).toEqual(bytes);
    });

    it('round-trips multi-byte characters without re-encoding damage', async () => {
      // Stored as a BLOB precisely so this cannot depend on how a string is
      // decoded and re-encoded on the way out.
      const tricky = 'café — 日本語 — 🧾 — \u0000 — ÿ';
      const bytes = toBytes(tricky);
      const { feedbackHash } = putReviewContent(db, { content: bytes, createdAt: 1_700_000_000 });

      const res = await getByUri(feedbackUriFor(BASE, feedbackHash));
      const served = new Uint8Array(await res.arrayBuffer());

      expect(keccak256(served)).toBe(feedbackHash);
      expect(served).toEqual(bytes);
    });

    it('refuses to store content under a hash that does not describe it', () => {
      // The repository recomputes rather than trusting a caller-supplied key,
      // so an upstream bug cannot publish a mismatched pair.
      const stored = putReviewContent(db, {
        content: toBytes(CONTENT),
        createdAt: 1_700_000_000,
      });

      expect(stored.feedbackHash).toBe(keccak256(toBytes(CONTENT)));
      expect(findReviewContent(db, stored.feedbackHash)?.content).toEqual(toBytes(CONTENT));
    });
  });

  describe('unknown hashes', () => {
    it('returns 404 for a well-formed hash that was never stored', async () => {
      const absent = keccak256(toBytes('never submitted'));

      const res = await getByUri(feedbackUriFor(BASE, absent));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    });

    it('returns 404 for a malformed hash rather than leaking a parse error', async () => {
      for (const bad of ['0xnothex', 'reviews', `0x${'aa'.repeat(31)}`, `0x${'aa'.repeat(33)}`]) {
        const res = await app().request(`/${REVIEW_PATH}/${bad}`);
        expect(res.status, bad).toBe(404);
      }
    });

    it('does not create a row as a side effect of a miss', async () => {
      const absent = keccak256(toBytes('never submitted'));
      await getByUri(feedbackUriFor(BASE, absent));

      expect(findReviewContent(db, absent)).toBeNull();
    });
  });

  describe('content is immutable under its hash', () => {
    it('ignores a second write of the same content', () => {
      const bytes = toBytes(CONTENT);
      const first = putReviewContent(db, { content: bytes, createdAt: 1_700_000_000 });
      const second = putReviewContent(db, { content: bytes, createdAt: 1_900_000_000 });

      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.feedbackHash).toBe(first.feedbackHash);

      // The original row wins, timestamp included — nothing was rewritten.
      expect(findReviewContent(db, first.feedbackHash)?.createdAt).toBe(1_700_000_000);
    });

    it('has no path that replaces the bytes under an existing hash', () => {
      const { feedbackHash } = putReviewContent(db, {
        content: toBytes(CONTENT),
        createdAt: 1_700_000_000,
      });

      // Different content cannot land on this key through the repository: it
      // derives the key from the bytes, so other bytes mean another row.
      const other = putReviewContent(db, {
        content: toBytes('rewritten after the fact'),
        createdAt: 1_700_000_001,
      });
      expect(other.feedbackHash).not.toBe(feedbackHash);

      expect(findReviewContent(db, feedbackHash)?.content).toEqual(toBytes(CONTENT));
    });

    it('rejects a direct overwrite attempt at the SQL level', () => {
      const { feedbackHash } = putReviewContent(db, {
        content: toBytes(CONTENT),
        createdAt: 1_700_000_000,
      });

      // Belt and braces: even bypassing the repository, the primary key makes a
      // plain insert fail rather than replace.
      expect(() =>
        db
          .prepare(
            `INSERT INTO review_contents (feedback_hash, content, created_at) VALUES (?,?,?)`,
          )
          .run(feedbackHash, Buffer.from(toBytes('tampered')), 1_700_000_002),
      ).toThrow(/UNIQUE|PRIMARY/i);

      expect(findReviewContent(db, feedbackHash)?.content).toEqual(toBytes(CONTENT));
    });

    it('rejects an UPDATE at the database, not just in the repository', () => {
      const { feedbackHash } = putReviewContent(db, {
        content: toBytes(CONTENT),
        createdAt: 1_700_000_000,
      });

      expect(() =>
        db
          .prepare(`UPDATE review_contents SET content = ? WHERE feedback_hash = ?`)
          .run(Buffer.from(toBytes('tampered')), feedbackHash),
      ).toThrow(/append-only/);

      // Still the original bytes, still under the same hash.
      const after = findReviewContent(db, feedbackHash);
      expect(after?.content).toEqual(toBytes(CONTENT));
      expect(keccak256(after?.content as Uint8Array)).toBe(feedbackHash);
    });

    it('rejects a DELETE at the database, not just in the repository', () => {
      const { feedbackHash } = putReviewContent(db, {
        content: toBytes(CONTENT),
        createdAt: 1_700_000_000,
      });

      expect(() =>
        db.prepare(`DELETE FROM review_contents WHERE feedback_hash = ?`).run(feedbackHash),
      ).toThrow(/append-only/);

      const after = findReviewContent(db, feedbackHash);
      expect(after?.content).toEqual(toBytes(CONTENT));
      expect(keccak256(after?.content as Uint8Array)).toBe(feedbackHash);
    });

    it('rejects an UPDATE or DELETE that names no row in particular', () => {
      putReviewContent(db, { content: toBytes(CONTENT), createdAt: 1_700_000_000 });

      expect(() => db.prepare(`UPDATE review_contents SET created_at = 0`).run()).toThrow(
        /append-only/,
      );
      expect(() => db.prepare(`DELETE FROM review_contents`).run()).toThrow(/append-only/);

      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM review_contents`).get() as { n: number },
      ).toEqual({ n: 1 });
    });

    it('closes the INSERT OR REPLACE route, which deletes before inserting', () => {
      const { feedbackHash } = putReviewContent(db, {
        content: toBytes(CONTENT),
        createdAt: 1_700_000_000,
      });

      expect(() =>
        db
          .prepare(
            `INSERT OR REPLACE INTO review_contents (feedback_hash, content, created_at)
             VALUES (?, ?, ?)`,
          )
          .run(feedbackHash, Buffer.from(toBytes('tampered')), 1_700_000_003),
      ).toThrow(/append-only/);

      expect(findReviewContent(db, feedbackHash)?.content).toEqual(toBytes(CONTENT));
    });

    it('still serves the original content over HTTP after every attempt', async () => {
      const { feedbackHash } = putReviewContent(db, {
        content: toBytes(CONTENT),
        createdAt: 1_700_000_000,
      });

      for (const attempt of [
        () =>
          db
            .prepare(`UPDATE review_contents SET content = ?`)
            .run(Buffer.from(toBytes('tampered'))),
        () => db.prepare(`DELETE FROM review_contents`).run(),
      ]) {
        expect(attempt).toThrow(/append-only/);
      }

      const res = await getByUri(feedbackUriFor(BASE, feedbackHash));
      expect(res.status).toBe(200);

      const served = new Uint8Array(await res.arrayBuffer());
      expect(keccak256(served)).toBe(feedbackHash);
      expect(new TextDecoder().decode(served)).toBe(CONTENT);
    });

    it('rejects malformed input before it reaches the database', () => {
      expect(() => putReviewContent(db, { content: new Uint8Array(), createdAt: 1 })).toThrow(
        InvalidReviewContentError,
      );
      expect(() => findReviewContent(db, 'not-a-hash')).toThrow(InvalidReviewContentError);
    });
  });

  describe('the base URL cannot malform the derived URI', () => {
    it('accepts a bare origin', () => {
      expect(normalizeReviewContentBaseUrl('https://receipts.example')).toBe(
        'https://receipts.example',
      );
      expect(normalizeReviewContentBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
    });

    it('normalizes trailing slashes so the join never doubles', () => {
      expect(normalizeReviewContentBaseUrl('https://receipts.example/')).toBe(
        'https://receipts.example',
      );
      expect(normalizeReviewContentBaseUrl('https://receipts.example///')).toBe(
        'https://receipts.example',
      );

      const hash: Hex = keccak256(toBytes(CONTENT));
      expect(feedbackUriFor('https://receipts.example/', hash)).toBe(
        `https://receipts.example/${REVIEW_PATH}/${hash}`,
      );
    });

    it('rejects anything that would swallow or leak into the signed URI', () => {
      const rejected = [
        'https://receipts.example/?x=1', // query would precede the hash
        'https://receipts.example/#frag', // fragment would precede the hash
        'https://user:pw@receipts.example', // credentials inside every attestation
        'ftp://receipts.example', // not fetchable over http(s)
        'javascript:alert(1)',
        'not a url',
        '',
        'https://receipts.example/a%2Fb',
        // A path prefix would sign a URI this server does not answer.
        'https://receipts.example/api',
        'https://receipts.example/deep/prefix',
      ];

      for (const value of rejected) {
        expect(normalizeReviewContentBaseUrl(value), value).toBeNull();
      }
    });

    it('produces a URI whose path is exactly what the route serves', async () => {
      const base = normalizeReviewContentBaseUrl('https://receipts.example/');
      expect(base).not.toBeNull();

      const { feedbackHash } = putReviewContent(db, {
        content: toBytes(CONTENT),
        createdAt: 1_700_000_000,
      });

      const res = await getByUri(feedbackUriFor(base as string, feedbackHash));
      expect(res.status).toBe(200);
      expect(keccak256(new Uint8Array(await res.arrayBuffer()))).toBe(feedbackHash);
    });
  });
});

import type { Migration } from '../migrate.js';

/**
 * The review text each `feedback_hash` commits to, served back over the derived
 * `feedbackURI`.
 *
 * Content-addressed and append-only. The hash is the primary key, so a second
 * write under an existing hash is a no-op rather than an update: there is no
 * code path that can replace the bytes an already-signed attestation points at.
 *
 * `content` is a BLOB holding the exact UTF-8 bytes that were hashed, not TEXT.
 * Storing the decoded string would make retrieval depend on re-encoding it the
 * same way, and the one property this table exists to guarantee is that the
 * bytes served back hash to the key they were served under.
 *
 * The triggers enforce append-only at the database, not merely in the
 * repository. Once an attestation is signed over `<base>/reviews/<hash>`, that
 * URI is on-chain and unchangeable, so the bytes behind it must be too — and a
 * guarantee that lives only in application code is one an ad-hoc query, a
 * future helper or a migration can step around. ABORT also closes the
 * `INSERT OR REPLACE` route, which SQLite implements as a delete followed by an
 * insert and which the BEFORE DELETE trigger therefore rejects.
 */
export const migration005ReviewContents: Migration = {
  id: '005_review_contents',
  sql: `
    CREATE TABLE review_contents (
      feedback_hash TEXT    PRIMARY KEY,
      content       BLOB    NOT NULL,
      created_at    INTEGER NOT NULL
    ) STRICT;

    CREATE TRIGGER review_contents_immutable_update
    BEFORE UPDATE ON review_contents
    BEGIN
      SELECT RAISE(ABORT, 'review_contents is append-only: content cannot be modified');
    END;

    CREATE TRIGGER review_contents_immutable_delete
    BEFORE DELETE ON review_contents
    BEGIN
      SELECT RAISE(ABORT, 'review_contents is append-only: content cannot be deleted');
    END;
  `,
};

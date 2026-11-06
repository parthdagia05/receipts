import { describe, expect, it } from 'vitest';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { getAddress, keccak256, toBytes } from 'viem';
import {
  InvalidProofPayloadError,
  PROOF_OF_HUMAN_IDENTIFIER,
  PROOF_OF_HUMAN_SCHEMA_ID,
  findProofOfHuman,
  isBoundToReviewer,
  normalizeNullifier,
  parseIDKitResult,
} from '../src/worldid/proof.js';
import { idkitResult, proofItem } from './proofFixtures.js';

const REVIEWER = getAddress('0xabababababababababababababababababababab');

describe('parseIDKitResult', () => {
  it('accepts a well-formed v4 uniqueness result', () => {
    const parsed = parseIDKitResult(idkitResult());

    expect(parsed.protocol_version).toBe('4.0');
    expect(parsed.action).toBe('review-agent-42');
    expect(parsed.environment).toBe('production');
    expect(parsed.responses).toHaveLength(1);
    expect(parsed.responses[0]?.identifier).toBe(PROOF_OF_HUMAN_IDENTIFIER);
  });

  it.each([
    ['not an object', 'nope'],
    ['an array', []],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, payload) => {
    expect(() => parseIDKitResult(payload)).toThrow(InvalidProofPayloadError);
  });

  describe('protocol version', () => {
    it('rejects a v3 result', () => {
      // v3 routes to a legacy branch at the API; this server only issues v4.
      expect(() => parseIDKitResult(idkitResult({ protocol_version: '3.0' }))).toThrow(
        /protocol_version must be "4.0"/,
      );
    });

    it('rejects a missing protocol version', () => {
      expect(() => parseIDKitResult(idkitResult({ protocol_version: undefined }))).toThrow(
        InvalidProofPayloadError,
      );
    });
  });

  describe('nonce', () => {
    it.each(['', 'abc', `0x${'ab'.repeat(31)}`, `0x${'zz'.repeat(32)}`, 'ab'.repeat(32)])(
      'rejects %o',
      (nonce) => {
        expect(() => parseIDKitResult(idkitResult({ nonce }))).toThrow(InvalidProofPayloadError);
      },
    );

    it('rejects a missing nonce', () => {
      expect(() => parseIDKitResult(idkitResult({ nonce: undefined }))).toThrow(
        InvalidProofPayloadError,
      );
    });
  });

  describe('environment', () => {
    it('rejects a missing environment rather than defaulting', () => {
      // The SDK's result type makes environment non-optional, so its absence is
      // a malformed payload, not an invitation to assume production.
      expect(() => parseIDKitResult(idkitResult({ environment: undefined }))).toThrow(
        /environment must be a non-empty string/,
      );
    });

    it('rejects an unknown environment', () => {
      expect(() => parseIDKitResult(idkitResult({ environment: 'prod' }))).toThrow(
        /environment must be one of/,
      );
    });

    it.each(['production', 'staging', 'sandbox'])('accepts %o', (environment) => {
      expect(parseIDKitResult(idkitResult({ environment })).environment).toBe(environment);
    });
  });

  describe('responses', () => {
    it.each([
      ['missing', undefined],
      ['empty', []],
      ['not an array', {}],
    ])('rejects %s responses', (_label, responses) => {
      expect(() => parseIDKitResult(idkitResult({ responses }))).toThrow(InvalidProofPayloadError);
    });

    it('rejects a non-object entry', () => {
      expect(() => parseIDKitResult(idkitResult({ responses: ['x'] }))).toThrow(
        InvalidProofPayloadError,
      );
    });
  });

  describe('proof element array', () => {
    it('requires exactly five decimal strings', () => {
      expect(parseIDKitResult(idkitResult()).responses[0]?.proof).toHaveLength(5);
    });

    it.each([
      ['a hex string instead of an array', '0xdeadbeef'],
      ['four elements', ['1', '2', '3', '4']],
      ['six elements', ['1', '2', '3', '4', '5', '6']],
      ['a non-decimal element', ['1', '2', '3', '4', '0xff']],
      ['a numeric element', ['1', '2', '3', '4', 5]],
    ])('rejects %s', (_label, proof) => {
      expect(() => parseIDKitResult(idkitResult({ responses: [proofItem({ proof })] }))).toThrow(
        /proof must be 5 decimal strings/,
      );
    });
  });

  describe('nullifier', () => {
    it('accepts hex, which is what World actually sends', () => {
      // Measured against the live staging verify endpoint on 2026-11-06: both
      // the IDKit payload and /api/v4/verify returned 0x + 64 hex characters,
      // although idkit-core's types annotate the field "(decimal)".
      expect(() =>
        parseIDKitResult(
          idkitResult({ responses: [proofItem({ nullifier: `0x${'ab'.repeat(32)}` })] }),
        ),
      ).not.toThrow();
    });

    it('accepts decimal', () => {
      expect(() =>
        parseIDKitResult(idkitResult({ responses: [proofItem({ nullifier: '12345' })] })),
      ).not.toThrow();
    });

    it('still rejects anything that is not a field element', () => {
      // '' is rejected earlier, by the non-empty-string check.
      for (const bad of ['abc', '0x', '0xzz', '12.5', '-1', `0x${'ab'.repeat(33)}`]) {
        expect(() =>
          parseIDKitResult(idkitResult({ responses: [proofItem({ nullifier: bad })] })),
        ).toThrow(/nullifier must be a field element/);
      }
    });

    it('collapses hex and decimal spellings of one identity to the same value', () => {
      // The uniqueness guarantee rests on a UNIQUE (agent_id, nullifier)
      // index. If 0xff and 255 stored as different strings, one person could
      // review twice by varying the encoding.
      expect(normalizeNullifier('0xff')).toBe('255');
      expect(normalizeNullifier('255')).toBe('255');
      expect(normalizeNullifier('0xFF')).toBe(normalizeNullifier('0x00ff'));
    });

    it('bounds decimal input at 78 digits, uint256 width, before parsing it', () => {
      const digits78 = '1'.repeat(78);
      expect(normalizeNullifier(digits78)).toBe(digits78);
      expect(() =>
        parseIDKitResult(idkitResult({ responses: [proofItem({ nullifier: digits78 })] })),
      ).not.toThrow();

      const digits79 = '1'.repeat(79);
      expect(normalizeNullifier(digits79)).toBeUndefined();
      expect(() =>
        parseIDKitResult(idkitResult({ responses: [proofItem({ nullifier: digits79 })] })),
      ).toThrow(/nullifier must be a field element/);
    });

    it('still accepts the hex and decimal forms that were valid before the bound', () => {
      const hex = `0x${'ab'.repeat(32)}`;
      expect(normalizeNullifier(hex)).toBe(BigInt(hex).toString(10));
      expect(normalizeNullifier('12345')).toBe('12345');
      expect(normalizeNullifier('007')).toBe('7');
      expect(normalizeNullifier(`0x${'f'.repeat(64)}`)).toBe((2n ** 256n - 1n).toString(10));
    });

    it('rejects a missing nullifier', () => {
      expect(() =>
        parseIDKitResult(idkitResult({ responses: [proofItem({ nullifier: undefined })] })),
      ).toThrow(InvalidProofPayloadError);
    });
  });

  describe('required v4 item fields', () => {
    it('rejects a missing issuer_schema_id', () => {
      expect(() =>
        parseIDKitResult(idkitResult({ responses: [proofItem({ issuer_schema_id: undefined })] })),
      ).toThrow(/issuer_schema_id must be an integer/);
    });

    it('rejects a missing expires_at_min', () => {
      expect(() =>
        parseIDKitResult(idkitResult({ responses: [proofItem({ expires_at_min: undefined })] })),
      ).toThrow(/expires_at_min must be an integer/);
    });

    it('rejects a non-string signal_hash when present', () => {
      expect(() =>
        parseIDKitResult(idkitResult({ responses: [proofItem({ signal_hash: 42 })] })),
      ).toThrow(/signal_hash must be a string/);
    });

    it('accepts an absent signal_hash at parse time', () => {
      // Shape is valid; the binding check is what rejects an unbound proof.
      const parsed = parseIDKitResult(
        idkitResult({ responses: [proofItem({ signal_hash: undefined })] }),
      );
      expect(parsed.responses[0]?.signal_hash).toBeUndefined();
    });
  });
});

describe('the complete payload survives validation', () => {
  it('returns the very object it was given', () => {
    // Identity, not equality: the Portal is sent the IDKit result, so anything
    // rebuilt here would be a different document from the one World App signed.
    const payload = idkitResult();

    expect(parseIDKitResult(payload)).toBe(payload);
  });

  it('preserves optional root fields', () => {
    const payload = idkitResult({
      action_description: 'Review agent 42',
      identity_attested: true,
      session_id: 'session_abc123',
      user_presence_completed: true,
      integrity_bundle: { format: 'apple_app_attest', signature: 'sig' },
    });

    const parsed = parseIDKitResult(payload) as Record<string, unknown>;

    expect(parsed['action_description']).toBe('Review agent 42');
    expect(parsed['identity_attested']).toBe(true);
    expect(parsed['session_id']).toBe('session_abc123');
    expect(parsed['user_presence_completed']).toBe(true);
    expect(parsed['integrity_bundle']).toEqual({
      format: 'apple_app_attest',
      signature: 'sig',
    });
  });

  it('preserves root fields it does not know about', () => {
    // A later World App may add fields; dropping them would change what the
    // Portal verifies.
    const payload = idkitResult({ some_future_field: { nested: [1, 2, 3] } });

    const parsed = parseIDKitResult(payload) as Record<string, unknown>;

    expect(parsed['some_future_field']).toEqual({ nested: [1, 2, 3] });
  });

  it('preserves optional and unknown response-item fields', () => {
    const payload = idkitResult({
      responses: [proofItem({ sybil_score: 7, some_future_item_field: 'keep me' })],
    });

    const item = parseIDKitResult(payload).responses[0] as Record<string, unknown>;

    expect(item['sybil_score']).toBe(7);
    expect(item['some_future_item_field']).toBe('keep me');
    // And the known fields are still there.
    expect(item['identifier']).toBe(PROOF_OF_HUMAN_IDENTIFIER);
    expect(item['nullifier']).toBe('123456789012345678901234567890');
  });

  it('round-trips through JSON unchanged', () => {
    // What the client sent is byte-for-byte what gets forwarded.
    const payload = idkitResult({
      action_description: 'desc',
      integrity_bundle: { a: 1 },
      responses: [proofItem({ sybil_score: 3 })],
    });
    const before = JSON.stringify(payload);

    expect(JSON.stringify(parseIDKitResult(payload))).toBe(before);
  });

  it('keeps the original response-item objects, not copies', () => {
    const payload = idkitResult();
    const originalItem = (payload['responses'] as unknown[])[0];

    expect(parseIDKitResult(payload).responses[0]).toBe(originalItem);
  });
});

describe('findProofOfHuman', () => {
  it('finds the matching credential', () => {
    const result = parseIDKitResult(idkitResult());

    expect(findProofOfHuman(result)?.identifier).toBe(PROOF_OF_HUMAN_IDENTIFIER);
  });

  it('ignores a credential with the wrong identifier', () => {
    const result = parseIDKitResult(
      idkitResult({ responses: [proofItem({ identifier: 'passport', issuer_schema_id: 9303 })] }),
    );

    expect(findProofOfHuman(result)).toBeUndefined();
  });

  it('ignores a proof_of_human identifier carrying the wrong schema id', () => {
    // Both are checked: the identifier alone is a free-form string.
    const result = parseIDKitResult(
      idkitResult({ responses: [proofItem({ issuer_schema_id: 9303 })] }),
    );

    expect(findProofOfHuman(result)).toBeUndefined();
  });

  it('picks the credential out of a multi-credential response', () => {
    const result = parseIDKitResult(
      idkitResult({
        responses: [
          proofItem({ identifier: 'passport', issuer_schema_id: 9303, nullifier: '99' }),
          proofItem({ nullifier: '42' }),
        ],
      }),
    );

    expect(findProofOfHuman(result)?.nullifier).toBe('42');
  });

  it('matches the documented schema id', () => {
    expect(PROOF_OF_HUMAN_SCHEMA_ID).toBe(1);
  });
});

describe('isBoundToReviewer', () => {
  it('accepts a signal hashed with the official helper', () => {
    const item = { ...proofItem({ signal_hash: hashSignal(REVIEWER) }) } as never;

    expect(isBoundToReviewer(item, REVIEWER)).toBe(true);
  });

  it('rejects a signal for a different wallet', () => {
    const other = getAddress(`0x${'cd'.repeat(20)}`);
    const item = { ...proofItem({ signal_hash: hashSignal(other) }) } as never;

    expect(isBoundToReviewer(item, REVIEWER)).toBe(false);
  });

  it('rejects an absent signal hash', () => {
    // No signal means nothing binds the proof to a wallet.
    const item = { ...proofItem({ signal_hash: undefined }) } as never;

    expect(isBoundToReviewer(item, REVIEWER)).toBe(false);
  });

  it('is unaffected by address checksum casing', () => {
    // hashSignal decodes 0x-hex to raw bytes, so casing cannot matter.
    const item = { ...proofItem({ signal_hash: hashSignal(REVIEWER.toLowerCase()) }) } as never;

    expect(isBoundToReviewer(item, REVIEWER)).toBe(true);
  });

  it('rejects a plain keccak of the address string', () => {
    // The trap this check exists for: hashSignal is keccak256 >> 8 over the
    // decoded bytes, so a naive keccak of the text is a different value.
    const naive = keccak256(toBytes(REVIEWER));
    const item = { ...proofItem({ signal_hash: naive }) } as never;

    expect(naive).not.toBe(hashSignal(REVIEWER));
    expect(isBoundToReviewer(item, REVIEWER)).toBe(false);
  });

  it('uses keccak256 shifted right by eight bits', () => {
    // Pins the algorithm, so an SDK change that alters it fails here rather
    // than silently rejecting every proof in production.
    const shifted = `0x${(BigInt(keccak256(toBytes(REVIEWER))) >> 8n).toString(16).padStart(64, '0')}`;

    expect(hashSignal(REVIEWER).toLowerCase()).toBe(shifted.toLowerCase());
  });
});

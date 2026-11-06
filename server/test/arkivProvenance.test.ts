import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  countProvenance,
  parseRpEnvironments,
  postgresRpLookup,
  resolveProvenance,
  RP_LOOKUP_SQL,
} from '../src/arkiv/provenance.js';
import type { RpLookup } from '../src/arkiv/provenance.js';
import type { ConfirmedReview } from '../src/arkiv/records.js';

/**
 * Provenance decides whether a published review says "production World ID"
 * or "staging (Simulator) test". Getting it wrong in the generous direction
 * would present a Simulator proof as a real credential, so every doubtful
 * case must come out `unknown`.
 */

const PROD_RP = 'rp_d3afb91156ea1942';
const STAGING_RP = 'rp_c357f900d4501523';
const MAP = parseRpEnvironments(`${PROD_RP}:production,${STAGING_RP}:staging`);

const review = (overrides: Partial<ConfirmedReview> = {}): ConfirmedReview => ({
  agentId: 11292n,
  gateway: '0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD' as Address,
  reviewer: '0x9e0bdBD447689531Ec27900BE895396b863C9986' as Address,
  reviewType: 0,
  tag: 'human-verified',
  value: 47n,
  valueDecimals: 0,
  feedbackIndex: 1n,
  feedbackHash: `0x${'3a'.repeat(32)}` as Hex,
  receiptId: `0x${'00'.repeat(32)}` as Hex,
  txHash: `0x${'7f'.repeat(32)}` as Hex,
  logIndex: 3,
  blockNumber: 12_078_168n,
  ...overrides,
});

const returns =
  (...rpIds: string[]): RpLookup =>
  async () =>
    rpIds;

describe('arkiv provenance: resolution', () => {
  it('labels a staging RP as staging and keeps the RP id', async () => {
    expect(await resolveProvenance(review(), [returns(STAGING_RP)], MAP)).toEqual({
      environment: 'staging',
      rpId: STAGING_RP,
    });
  });

  it('labels a production RP as production', async () => {
    expect(await resolveProvenance(review(), [returns(PROD_RP)], MAP)).toEqual({
      environment: 'production',
      rpId: PROD_RP,
    });
  });

  it('agreeing sources are one answer', async () => {
    const p = await resolveProvenance(review(), [returns(STAGING_RP), returns(STAGING_RP)], MAP);
    expect(p.environment).toBe('staging');
  });

  it('is unknown with no record, no sources, or sources that disagree', async () => {
    expect((await resolveProvenance(review(), [returns()], MAP)).environment).toBe('unknown');
    expect((await resolveProvenance(review(), [], MAP)).environment).toBe('unknown');
    expect(
      (await resolveProvenance(review(), [returns(STAGING_RP), returns(PROD_RP)], MAP)).environment,
    ).toBe('unknown');
  });

  it('is unknown for an RP missing from the map, but says which RP it was', async () => {
    const other = 'rp_0000000000000001';
    expect(await resolveProvenance(review(), [returns(other)], MAP)).toEqual({
      environment: 'unknown',
      rpId: other,
    });
  });

  it('is unknown, with no RP id, for a value that is not an RP id', async () => {
    expect(await resolveProvenance(review(), [returns('not-an-rp')], MAP)).toEqual({
      environment: 'unknown',
    });
  });

  it('a wallet-verified review involved no World ID and is not looked up', async () => {
    let called = false;
    const spy: RpLookup = async () => {
      called = true;
      return [PROD_RP];
    };
    expect(await resolveProvenance(review({ reviewType: 2 }), [spy], MAP)).toEqual({
      environment: 'none',
    });
    expect(called).toBe(false);
  });
});

describe('arkiv provenance: configuration', () => {
  it('rejects malformed entries and an RP listed as both environments', () => {
    expect(() => parseRpEnvironments('rp_123:production')).toThrow();
    expect(() => parseRpEnvironments(`${PROD_RP}:orb`)).toThrow();
    expect(() => parseRpEnvironments(`${PROD_RP}:production,${PROD_RP}:staging`)).toThrow(/both/);
    expect(parseRpEnvironments('').size).toBe(0);
  });
});

describe('arkiv provenance: the database query', () => {
  it('reads the RP id and nothing private', () => {
    const selected = RP_LOOKUP_SQL.slice(
      RP_LOOKUP_SQL.indexOf('SELECT'),
      RP_LOOKUP_SQL.indexOf('FROM'),
    );
    expect(selected.replace(/\s+/g, ' ').trim()).toBe('SELECT DISTINCT r.rp_id');
    expect(RP_LOOKUP_SQL).not.toMatch(/nullifier|signature|\*/i);
  });

  it('matches on hash, agent, reviewer and type, and keeps only string RP ids', async () => {
    const seen: unknown[][] = [];
    const lookup = postgresRpLookup({
      async query(_sql, params) {
        seen.push([...params]);
        return { rows: [{ rp_id: STAGING_RP }, { rp_id: null }] };
      },
    });
    expect(await lookup(review())).toEqual([STAGING_RP]);
    expect(seen[0]).toEqual([
      `0x${'3a'.repeat(32)}`,
      '11292',
      '0x9e0bdBD447689531Ec27900BE895396b863C9986',
      0,
    ]);
  });
});

describe('arkiv provenance: snapshot counts', () => {
  it('counts human-labelled reviews by environment and leaves wallet reviews out', () => {
    expect(
      countProvenance([
        { environment: 'staging', rpId: STAGING_RP },
        { environment: 'staging', rpId: STAGING_RP },
        { environment: 'production', rpId: PROD_RP },
        { environment: 'unknown' },
        { environment: 'none' },
      ]),
    ).toEqual({ production: 1, staging: 2, unknown: 1 });
  });
});

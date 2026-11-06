import { describe, expect, it } from 'vitest';
import * as server from '../../../server/src/arkiv/schemas';
import { keccak256 } from 'viem';
import type { Hex } from 'viem';
import {
  compareWithChain,
  contentStatus,
  curlFor,
  isExpired,
  readEnvironment,
  ReputationSchema,
  ReviewSchema,
  snapshotStanding,
  timeLeft,
  unpublishedCount,
} from './arkiv';
import type { ArkivReview, ChainReview } from './arkiv';

/**
 * The web copy of the Arkiv schemas must be the published interface the
 * server writes, column for column. A drift would make the panel silently
 * skip every entity as a schema mismatch.
 */
describe('arkiv schemas', () => {
  const shape = (schema: { name: string | undefined; columns: object }) => ({
    name: schema.name,
    columns: Object.fromEntries(
      Object.entries(schema.columns).map(([name, c]) => [
        name,
        {
          type: c.type,
          indexed: c.isIndexed,
          optional: c.isOptional,
          default: c.defaultValue?.value,
        },
      ]),
    ),
  });

  it('match the server, column for column', () => {
    expect(shape(ReviewSchema)).toEqual(shape(server.ReviewSchema));
    expect(shape(ReputationSchema)).toEqual(shape(server.ReputationSchema));
  });
});

describe('curlFor', () => {
  it('produces a JSON-RPC body that survives shell quoting', () => {
    const query = "arkiv.schema = str('receipts.review/v1') AND agentId = str('42')";
    const command = curlFor(query);
    expect(command.startsWith('curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network ')).toBe(
      true,
    );

    // Undo the shell's single-quote escaping the way sh would.
    const quoted = command.slice(command.indexOf(" -d '") + 5, -1).replace(/'\\''/g, "'");
    const body = JSON.parse(quoted) as { method: string; params: [string, unknown] };
    expect(body.method).toBe('arkiv_query');
    expect(body.params[0]).toBe(query);
  });
});

describe('timeLeft', () => {
  it('reads blocks as two seconds each', () => {
    expect(timeLeft(100n + 43_200n * 7n, 100n)).toBe('7 days');
    expect(timeLeft(100n + 1_800n, 100n)).toBe('1 hour');
    expect(timeLeft(100n, 100n)).toBe('expired');
  });
});

describe('contentStatus', () => {
  const text = new TextEncoder().encode('worked as described');
  const hash = keccak256(text);

  it('verifies bytes that hash to the on-chain value, whatever its case', () => {
    expect(contentStatus(text, hash)).toBe('verified');
    expect(contentStatus(text, hash.toUpperCase().replace('0X', '0x') as Hex)).toBe('verified');
  });

  it('reports a mismatch rather than trusting the entity', () => {
    expect(contentStatus(new TextEncoder().encode('edited'), hash)).toBe('mismatch');
  });

  it('reports absent content separately from a mismatch', () => {
    expect(contentStatus(null, hash)).toBe('absent');
  });
});

describe('compareWithChain', () => {
  const reviewer = '0x9e0bdBD447689531Ec27900BE895396b863C9986' as const;
  const feedbackHash = `0x${'ab'.repeat(32)}` as Hex;
  const txHash = `0x${'cd'.repeat(32)}` as Hex;
  const arkiv: ArkivReview = {
    entityKey: `0x${'01'.repeat(32)}`,
    expiresAt: 1_000n,
    gateway: '0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD',
    reviewType: 0,
    tag: 'human-verified',
    value: 80,
    reviewer,
    feedbackIndex: 1n,
    txHash,
    blockNumber: 12_077_737n,
    feedbackHash,
    text: null,
    contentStatus: 'absent',
    worldIdEnvironment: 'staging',
    worldIdRpId: 'rp_c357f900d4501523',
  };
  const chain: ChainReview = {
    transactionHash: txHash.toUpperCase().replace('0X', '0x') as Hex,
    reviewer: reviewer.toLowerCase() as Hex,
    reviewType: 0,
    feedbackHash,
    blockNumber: 12_077_737n,
  };

  it('matches the Sepolia review in the same transaction', () => {
    expect(compareWithChain(arkiv, [chain])).toBe('matches');
  });

  it('flags any disagreement on the fields it mirrors', () => {
    expect(compareWithChain(arkiv, [{ ...chain, reviewType: 1 }])).toBe('differs');
    expect(compareWithChain(arkiv, [{ ...chain, blockNumber: 1n }])).toBe('differs');
    expect(
      compareWithChain(arkiv, [{ ...chain, feedbackHash: `0x${'ef'.repeat(32)}` as Hex }]),
    ).toBe('differs');
  });

  it('treats a transaction missing from the capped list as unlisted, not a mismatch', () => {
    expect(compareWithChain(arkiv, [])).toBe('unlisted');
  });

  it('counts Sepolia reviews that have no entity yet', () => {
    const other = { ...chain, transactionHash: `0x${'99'.repeat(32)}` as Hex };
    expect(unpublishedCount([arkiv], [chain, other])).toBe(1);
    expect(unpublishedCount([], [chain])).toBe(1);
  });
});

describe('isExpired', () => {
  it('is expired at and after the expiry block', () => {
    expect(isExpired(100n, 99n)).toBe(false);
    expect(isExpired(100n, 100n)).toBe(true);
  });
});

describe('provenance', () => {
  it('reads only the four known labels and treats anything else as unknown', () => {
    expect(readEnvironment('production')).toBe('production');
    expect(readEnvironment('staging')).toBe('staging');
    expect(readEnvironment('none')).toBe('none');
    expect(readEnvironment('orb')).toBe('unknown');
    expect(readEnvironment(undefined)).toBe('unknown');
  });

  it('marks a snapshot as a test when any review was a Simulator verification', () => {
    const counts = {
      productionVerifiedCount: 3,
      stagingVerifiedCount: 1,
      unknownProvenanceCount: 1,
    };
    expect(snapshotStanding(counts)).toBe('test');
    expect(snapshotStanding({ ...counts, stagingVerifiedCount: 0 })).toBe('unverified');
    expect(
      snapshotStanding({ ...counts, stagingVerifiedCount: 0, unknownProvenanceCount: 0 }),
    ).toBe('production');
  });
});

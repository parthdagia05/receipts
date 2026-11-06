import { describe, expect, it } from 'vitest';
import * as server from '../../../server/src/arkiv/schemas';
import { curlFor, ReputationSchema, ReviewSchema, timeLeft } from './arkiv';

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

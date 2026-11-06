import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { reputationRoute } from '../src/routes/reputation.js';
import { VALID_ENV } from './fixtures.js';

/**
 * The snapshot must be pinned BEHIND the head, and the setting that does it
 * must actually reach the retrieval layer.
 *
 * This is a regression test for a live outage, not a hypothetical. The
 * reputation endpoint failed roughly five requests in six against a public
 * RPC endpoint, with:
 *
 *   block range extends beyond current head block: requested N, head N-1
 *
 * `retrieveReviews` already supported `confirmations`, and `evidence.ts`
 * already documented the reorg policy it implements — but nothing ever
 * passed it, so it defaulted to zero and every read was taken AT the head.
 * Public endpoints are load-balanced pools whose nodes are not always on the
 * same block, so the head came from one node and the log query landed on
 * another that was one block behind.
 *
 * A test that only covered `retrieveReviews` would have passed throughout.
 * The defect was entirely in the wiring, so that is what is asserted here.
 */

describe('reputation snapshot lag', () => {
  describe('configuration', () => {
    it('defaults to staying 2 blocks behind the head', () => {
      // Not zero. Zero is what produced the outage.
      expect(loadEnv(VALID_ENV).reputationConfirmations).toBe(2n);
    });

    it('is tunable, so a dedicated RPC endpoint can go back to 0', () => {
      expect(loadEnv({ ...VALID_ENV, REPUTATION_CONFIRMATIONS: '0' }).reputationConfirmations).toBe(
        0n,
      );
      expect(
        loadEnv({ ...VALID_ENV, REPUTATION_CONFIRMATIONS: '12' }).reputationConfirmations,
      ).toBe(12n);
    });

    it('refuses a malformed value rather than silently reading at the head', () => {
      expect(() => loadEnv({ ...VALID_ENV, REPUTATION_CONFIRMATIONS: 'soon' })).toThrow(
        /REPUTATION_CONFIRMATIONS/,
      );
      expect(() => loadEnv({ ...VALID_ENV, REPUTATION_CONFIRMATIONS: '-1' })).toThrow(
        /REPUTATION_CONFIRMATIONS/,
      );
    });

    it('is reported in the redacted config, since it changes what a score means', async () => {
      const { redactEnv } = await import('../src/config/env.js');
      expect(redactEnv(loadEnv(VALID_ENV))['reputationConfirmations']).toBe('2');
    });
  });

  describe('wiring', () => {
    /**
     * A client that records the block numbers it is asked about. Only the
     * two calls the route makes before anything else are needed: the head,
     * and the log query whose `toBlock` is the pinned snapshot.
     */
    function recordingClient(head: bigint) {
      const seen: { toBlock?: bigint } = {};
      return {
        seen,
        client: {
          getBlockNumber: async () => head,
          // The retrieval uses getContractEvents, not getLogs.
          getContractEvents: async (args: { toBlock?: bigint }) => {
            // Guarded because `exactOptionalPropertyTypes` forbids writing
            // `undefined` into an optional property. The assertions are
            // unaffected: an absent toBlock leaves `seen.toBlock`
            // `undefined` either way, so a retrieval that stopped passing
            // one would still fail the test rather than slip through.
            if (args.toBlock !== undefined) {
              seen.toBlock = args.toBlock;
            }
            // Enough to stop the route before it needs anything else.
            throw new Error('stop-after-log-query');
          },
        } as never,
      };
    }

    const contracts = {
      reviewGateway: '0xC4052D50FAA61f43fadA76AEDE7dbf70381cA9BD',
      receiptSettler: '0xC3AA7a2F43d83680f9E0B97e0Eb4fD01E421ceDe',
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    } as const;

    it('queries up to head - confirmations, not up to head', async () => {
      const { client, seen } = recordingClient(1_000n);

      const res = await reputationRoute({
        client,
        chainId: 11155111,
        contracts,
        gatewayDeployBlock: 900n,
        confirmations: 2n,
      }).request('/api/agents/11265/reputation');

      // The read fails by construction; what matters is the block it asked for.
      expect(res.status).toBe(503);
      expect(seen.toBlock).toBe(998n);
    });

    it('reads at the head when confirmations is 0, which is the racy behaviour', async () => {
      const { client, seen } = recordingClient(1_000n);

      await reputationRoute({
        client,
        chainId: 11155111,
        contracts,
        gatewayDeployBlock: 900n,
        confirmations: 0n,
      }).request('/api/agents/11265/reputation');

      expect(seen.toBlock).toBe(1_000n);
    });

    it('still fails closed rather than scoring a partial read', async () => {
      const { client } = recordingClient(1_000n);

      const res = await reputationRoute({
        client,
        chainId: 11155111,
        contracts,
        gatewayDeployBlock: 900n,
        confirmations: 2n,
      }).request('/api/agents/11265/reputation');

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'chain_read_failed' });
    });
  });
});

import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import type { Address } from 'viem';
import type { GatewayReader } from '../src/chain/gateway.js';
import { DeploymentVerificationError, verifyDeployment } from '../src/chain/verifyDeployment.js';
import { VALID_ENV } from './fixtures.js';

const KEY = VALID_ENV.RECORD_SERVER_PRIVATE_KEY as `0x${string}`;
const EXPECTED = privateKeyToAddress(KEY);
const CHAIN_ID = 11155111;

/** A reader with fixed answers; no network. */
function reader(overrides: {
  chainId?: number | (() => never);
  signer?: Address | (() => never);
}): GatewayReader {
  return {
    async getChainId() {
      const v = overrides.chainId ?? CHAIN_ID;
      return typeof v === 'function' ? v() : v;
    },
    async getRecordServerSigner() {
      const v = overrides.signer ?? EXPECTED;
      return typeof v === 'function' ? v() : v;
    },
  };
}

const verify = (r: GatewayReader) =>
  verifyDeployment({
    reader: r,
    recordServerPrivateKey: KEY,
    expectedChainId: CHAIN_ID,
  });

describe('verifyDeployment', () => {
  it('passes when the gateway signer matches the derived address', async () => {
    await expect(verify(reader({}))).resolves.toEqual({
      recordServerAddress: EXPECTED,
      chainId: CHAIN_ID,
    });
  });

  it('matches regardless of the casing the RPC returns', async () => {
    // A node may answer with a lowercase address; comparison is checksum-safe.
    const lowercased = EXPECTED.toLowerCase() as Address;

    await expect(verify(reader({ signer: lowercased }))).resolves.toMatchObject({
      recordServerAddress: EXPECTED,
    });
  });

  it('fails when the gateway expects a different signer', async () => {
    const other = getAddress(`0x${'99'.repeat(20)}`);

    await expect(verify(reader({ signer: other }))).rejects.toThrow(DeploymentVerificationError);
    await expect(verify(reader({ signer: other }))).rejects.toThrow(
      /ReviewGateway expects attestations from/,
    );
  });

  it('names both addresses in a signer mismatch', async () => {
    const other = getAddress(`0x${'99'.repeat(20)}`);

    await expect(verify(reader({ signer: other }))).rejects.toThrow(
      new RegExp(`${other}.*${EXPECTED}`),
    );
  });

  it('fails when the RPC serves a different chain', async () => {
    await expect(verify(reader({ chainId: 1 }))).rejects.toThrow(
      /serves chain 1, but CHAIN_ID is 11155111/,
    );
  });

  it('reports a chain mismatch rather than a signer mismatch', async () => {
    // Wrong chain means the signer read came from the wrong deployment; naming
    // the signer would point at the wrong fault.
    const wrongChain = reader({ chainId: 1, signer: getAddress(`0x${'99'.repeat(20)}`) });

    await expect(verify(wrongChain)).rejects.toThrow(/serves chain 1/);
    await expect(verify(wrongChain)).rejects.not.toThrow(/expects attestations from/);
  });

  it('fails safely when the RPC is unreachable', async () => {
    const boom = (): never => {
      throw new Error('fetch failed: https://rpc.example.com/v1/secret-api-key');
    };

    await expect(verify(reader({ chainId: boom }))).rejects.toThrow(
      /could not reach the configured RPC endpoint/,
    );
  });

  it('fails safely when the gateway call reverts', async () => {
    const boom = (): never => {
      throw new Error('execution reverted');
    };

    await expect(verify(reader({ signer: boom }))).rejects.toThrow(
      /could not read recordServerSigner\(\)/,
    );
  });

  describe('private key validation', () => {
    const verifyWithKey = (key: string) =>
      verifyDeployment({
        reader: reader({}),
        recordServerPrivateKey: key as `0x${string}`,
        expectedChainId: CHAIN_ID,
      });

    it.each([
      ['malformed', 'not-a-key'],
      ['too short', '0x1234'],
      ['missing 0x', '11'.repeat(32)],
      ['non-hex', `0x${'zz'.repeat(32)}`],
      ['31 bytes', `0x${'11'.repeat(31)}`],
      ['empty', ''],
    ])('rejects a %s key', async (_label, key) => {
      await expect(verifyWithKey(key)).rejects.toThrow(DeploymentVerificationError);
      await expect(verifyWithKey(key)).rejects.toThrow(
        /RECORD_SERVER_PRIVATE_KEY is not a valid secp256k1 private key/,
      );
    });

    it.each([
      ['zero scalar', `0x${'00'.repeat(32)}`],
      ['group order', '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'],
      ['above the order', `0x${'ff'.repeat(32)}`],
    ])('rejects an out-of-range key (%s)', async (_label, key) => {
      await expect(verifyWithKey(key)).rejects.toThrow(DeploymentVerificationError);
    });

    it('accepts the largest valid scalar', async () => {
      const nMinusOne = '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140';
      const address = privateKeyToAddress(nMinusOne);

      await expect(
        verifyDeployment({
          reader: reader({ signer: address }),
          recordServerPrivateKey: nMinusOne,
          expectedChainId: CHAIN_ID,
        }),
      ).resolves.toMatchObject({ recordServerAddress: address });
    });

    it('fails before touching the RPC', async () => {
      // An unusable key is a configuration fault; there is nothing to ask the
      // chain about, so the reader must not be called at all.
      let called = false;
      const spy: GatewayReader = {
        async getChainId() {
          called = true;
          return CHAIN_ID;
        },
        async getRecordServerSigner() {
          called = true;
          return EXPECTED;
        },
      };

      await expect(
        verifyDeployment({
          reader: spy,
          recordServerPrivateKey: '0xdeadbeef' as `0x${string}`,
          expectedChainId: CHAIN_ID,
        }),
      ).rejects.toThrow(DeploymentVerificationError);

      expect(called).toBe(false);
    });

    it('never leaks key material for an out-of-range scalar', async () => {
      // viem renders an out-of-range scalar as a decimal integer.
      const key = `0x${'ff'.repeat(32)}`;

      let message = '';
      try {
        await verifyWithKey(key);
      } catch (err) {
        message = (err as Error).message;
      }

      expect(message).not.toBe('');
      expect(message).not.toContain(key);
      expect(message).not.toContain(key.slice(2));
      expect(message).not.toContain(BigInt(key).toString(10));
    });
  });

  describe('secret confidentiality', () => {
    const messageFrom = async (r: GatewayReader): Promise<string> => {
      try {
        await verify(r);
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    };

    it('never includes the private key in a mismatch', async () => {
      const message = await messageFrom(reader({ signer: getAddress(`0x${'99'.repeat(20)}`) }));

      expect(message).not.toBe('');
      expect(message).not.toContain(KEY);
      expect(message).not.toContain(KEY.slice(2));
    });

    it('never includes the RPC URL or its API key', async () => {
      const url = 'https://rpc.example.com/v1/secret-api-key';
      const boom = (): never => {
        throw new Error(`fetch failed: ${url}`);
      };

      for (const r of [reader({ chainId: boom }), reader({ signer: boom })]) {
        const message = await messageFrom(r);
        expect(message).not.toContain(url);
        expect(message).not.toContain('secret-api-key');
      }
    });

    it('never includes the private key in a chain mismatch', async () => {
      const message = await messageFrom(reader({ chainId: 1 }));

      expect(message).not.toContain(KEY);
      expect(message).not.toContain(KEY.slice(2));
    });
  });
});

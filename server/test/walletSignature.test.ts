import { describe, expect, it } from 'vitest';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  TimeoutError,
  createPublicClient,
  custom,
  getAddress,
  hashTypedData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { authorizationTypedData } from '../src/signing/reviewAuthorization.js';
import type { AuthorizationTypedData } from '../src/signing/reviewAuthorization.js';
import {
  ERC1271_MAGIC_VALUE,
  ERC6492_SUFFIX,
  IncompleteBlockError,
  classifyContractReadError,
  createPublicClientReader,
  verifyWalletSignature,
} from '../src/signing/walletSignature.js';
import type { ContractWalletReader, VerificationBlock } from '../src/signing/walletSignature.js';
import { AUTH_VECTOR, authorization } from './authorizationFixtures.js';

/** Deterministic test key; clearly synthetic, never a real credential. */
const REVIEWER_KEY: Hex = `0x${'11'.repeat(32)}`;
const OTHER_KEY: Hex = `0x${'22'.repeat(32)}`;
const reviewerAccount = privateKeyToAccount(REVIEWER_KEY);

const HEAD: VerificationBlock = { number: 21_000_000n, hash: `0x${'11'.repeat(32)}` };
const WALLET_CODE: Hex = '0x60806040';

/** The ABI the verifier uses, restated so real viem errors can be constructed. */
const ERC1271_ABI = [
  {
    name: 'isValidSignature',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'hash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes4' }],
  },
] as const;

/** A revert as viem actually surfaces it: wrapped in an execution error. */
function revertError(): ContractFunctionExecutionError {
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi: ERC1271_ABI,
      functionName: 'isValidSignature',
      message: 'execution reverted',
    }),
    { abi: ERC1271_ABI, functionName: 'isValidSignature', args: ['0x00', '0x00'] },
  );
}

/** Typed data for the fixture authorization, bound to the fixture reviewer. */
function typedDataFor(reviewer: Address, overrides = {}): AuthorizationTypedData {
  return authorizationTypedData(
    authorization({ reviewer, ...overrides }),
    AUTH_VECTOR.chainId,
    AUTH_VECTOR.gateway,
  );
}

const BASE = typedDataFor(reviewerAccount.address);

async function signWith(key: Hex, data: AuthorizationTypedData): Promise<Hex> {
  return privateKeyToAccount(key).signTypedData({
    domain: data.domain,
    types: data.types,
    primaryType: data.primaryType,
    message: data.message,
  });
}

/** A reader with fixed answers; records what it was asked. */
function fakeReader(
  overrides: {
    code?: Hex | undefined | (() => never);
    magic?: Hex | (() => never);
    head?: VerificationBlock | (() => never);
  } = {},
): { reader: ContractWalletReader; asked: Record<string, unknown>[] } {
  const asked: Record<string, unknown>[] = [];
  const reader: ContractWalletReader = {
    async getBlock(blockNumber) {
      const v = overrides.head ?? HEAD;
      if (typeof v === 'function') return v();
      asked.push({ call: 'getBlock', blockNumber });
      return blockNumber === undefined ? v : { number: blockNumber, hash: v.hash };
    },
    async getCode(p) {
      const v =
        overrides.code === undefined && !('code' in overrides) ? WALLET_CODE : overrides.code;
      if (typeof v === 'function') return v();
      asked.push({ call: 'getCode', ...p });
      return v;
    },
    async isValidSignature(p) {
      const v = overrides.magic ?? ERC1271_MAGIC_VALUE;
      if (typeof v === 'function') return v();
      asked.push({ call: 'isValidSignature', ...p });
      return v as Hex;
    },
  };
  return { reader, asked };
}

describe('EOA signatures', () => {
  it('accepts a signature from the expected reviewer', async () => {
    const signature = await signWith(REVIEWER_KEY, BASE);

    await expect(
      verifyWalletSignature({
        expectedReviewer: reviewerAccount.address,
        typedData: BASE,
        signature,
      }),
    ).resolves.toEqual({ ok: true, method: 'eoa' });
  });

  it('needs no chain access for the EOA path', async () => {
    const { reader, asked } = fakeReader();
    const signature = await signWith(REVIEWER_KEY, BASE);

    await verifyWalletSignature({
      expectedReviewer: reviewerAccount.address,
      typedData: BASE,
      signature,
      reader,
    });

    expect(asked).toEqual([]);
  });

  it('accepts whatever casing the expected address is given in', async () => {
    const signature = await signWith(REVIEWER_KEY, BASE);

    await expect(
      verifyWalletSignature({
        expectedReviewer: reviewerAccount.address.toLowerCase() as Address,
        typedData: BASE,
        signature,
      }),
    ).resolves.toEqual({ ok: true, method: 'eoa' });
  });

  it('rejects a signature from a different wallet', async () => {
    const signature = await signWith(OTHER_KEY, BASE);

    await expect(
      verifyWalletSignature({
        expectedReviewer: reviewerAccount.address,
        typedData: BASE,
        signature,
      }),
    ).resolves.toEqual({ ok: false, reason: 'signer_mismatch' });
  });

  describe('modified authorization content', () => {
    const mutations: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['agentId', { agentId: 43n }],
      ['value', { value: 81n }],
      ['feedbackHash', { feedbackHash: `0x${'45'.repeat(32)}` }],
      ['nonce', { nonce: `0x${'66'.repeat(32)}` }],
      ['deadline', { deadline: 1_800_000_001n }],
    ];

    it.each(mutations)('rejects when %s changed after signing', async (_field, mutation) => {
      // Signed over the original, presented against the altered document.
      const signature = await signWith(REVIEWER_KEY, BASE);
      const altered = typedDataFor(reviewerAccount.address, mutation);

      await expect(
        verifyWalletSignature({
          expectedReviewer: reviewerAccount.address,
          typedData: altered,
          signature,
        }),
      ).resolves.toEqual({ ok: false, reason: 'signer_mismatch' });
    });
  });

  describe('modified domain', () => {
    it('rejects a signature made for another chain', async () => {
      const signature = await signWith(
        REVIEWER_KEY,
        authorizationTypedData(
          authorization({ reviewer: reviewerAccount.address }),
          1,
          AUTH_VECTOR.gateway,
        ),
      );

      await expect(
        verifyWalletSignature({
          expectedReviewer: reviewerAccount.address,
          typedData: BASE,
          signature,
        }),
      ).resolves.toEqual({ ok: false, reason: 'signer_mismatch' });
    });

    it('rejects a signature made for another gateway', async () => {
      const signature = await signWith(
        REVIEWER_KEY,
        authorizationTypedData(
          authorization({ reviewer: reviewerAccount.address }),
          AUTH_VECTOR.chainId,
          getAddress(`0x${'ee'.repeat(20)}`),
        ),
      );

      await expect(
        verifyWalletSignature({
          expectedReviewer: reviewerAccount.address,
          typedData: BASE,
          signature,
        }),
      ).resolves.toEqual({ ok: false, reason: 'signer_mismatch' });
    });
  });

  describe('malformed signatures', () => {
    it.each(['0x', '0xdeadbeef', `0x${'ab'.repeat(64)}`, 'not-hex'])(
      'rejects %o without chain access',
      async (signature) => {
        await expect(
          verifyWalletSignature({
            expectedReviewer: reviewerAccount.address,
            typedData: BASE,
            signature: signature as Hex,
          }),
        ).resolves.toEqual({ ok: false, reason: 'malformed_signature' });
      },
    );

    it('rejects a signature with a corrupted byte', async () => {
      const signature = await signWith(REVIEWER_KEY, BASE);
      const flipped = (signature.slice(0, 20) +
        (signature[20] === 'a' ? 'b' : 'a') +
        signature.slice(21)) as Hex;

      const result = await verifyWalletSignature({
        expectedReviewer: reviewerAccount.address,
        typedData: BASE,
        signature: flipped,
      });

      expect(result.ok).toBe(false);
    });
  });
});

describe('ERC-1271 contract wallets', () => {
  // A smart wallet's signature need not be 65 bytes and generally will not
  // recover, which is what sends verification down the contract path.
  const WALLET: Address = getAddress(`0x${'77'.repeat(20)}`);
  const CONTRACT_SIGNATURE: Hex = `0x${'ab'.repeat(96)}`;

  const verifyAgainstWallet = (
    reader: ContractWalletReader,
    extra: { blockNumber?: bigint } = {},
  ) =>
    verifyWalletSignature({
      expectedReviewer: WALLET,
      typedData: typedDataFor(WALLET),
      signature: CONTRACT_SIGNATURE,
      reader,
      ...extra,
    });

  it('accepts a wallet that returns the magic value', async () => {
    const { reader } = fakeReader();

    await expect(verifyAgainstWallet(reader)).resolves.toEqual({
      ok: true,
      method: 'erc1271',
      block: HEAD,
    });
  });

  it('rejects a wallet that returns a different value', async () => {
    const { reader } = fakeReader({ magic: '0xffffffff' });

    await expect(verifyAgainstWallet(reader)).resolves.toEqual({
      ok: false,
      reason: 'invalid_contract_signature',
    });
  });

  it.each([undefined, '0x' as Hex])('rejects an address with no bytecode (%o)', async (code) => {
    const { reader, asked } = fakeReader({ code });

    const result = await verifyAgainstWallet(reader);

    expect(result.ok).toBe(false);
    // The wallet is never asked when it is not a contract.
    expect(asked.some((a) => a['call'] === 'isValidSignature')).toBe(false);
  });

  describe('error classification', () => {
    /** Run the contract path with `isValidSignature` throwing `err`. */
    const failingWith = (err: unknown) =>
      verifyAgainstWallet(
        fakeReader({
          magic: () => {
            throw err;
          },
        }).reader,
      );

    it('classifies a genuine revert as an invalid contract signature', async () => {
      // As viem actually surfaces it: ContractFunctionRevertedError wrapped in
      // a ContractFunctionExecutionError.
      await expect(failingWith(revertError())).resolves.toEqual({
        ok: false,
        reason: 'invalid_contract_signature',
      });
    });

    it('classifies a bare revert error as invalid', async () => {
      await expect(
        failingWith(
          new ContractFunctionRevertedError({
            abi: ERC1271_ABI,
            functionName: 'isValidSignature',
            message: 'reverted',
          }),
        ),
      ).resolves.toEqual({ ok: false, reason: 'invalid_contract_signature' });
    });

    it('fails closed when the wallet returns no data', async () => {
      await expect(
        failingWith(new ContractFunctionZeroDataError({ functionName: 'isValidSignature' })),
      ).resolves.toEqual({ ok: false, reason: 'invalid_contract_signature' });
    });

    it('classifies an HTTP transport failure as unavailable', async () => {
      const err = new HttpRequestError({
        url: 'https://rpc.example.com/v1/secret-key',
        status: 503,
      });

      const result = await failingWith(err);

      expect(result).toEqual({ ok: false, reason: 'verification_unavailable' });
      expect(JSON.stringify(result)).not.toContain('secret-key');
      expect(JSON.stringify(result)).not.toContain('rpc.example.com');
    });

    it('classifies a timeout as unavailable', async () => {
      await expect(
        failingWith(new TimeoutError({ body: {}, url: 'https://rpc.example.com' })),
      ).resolves.toEqual({ ok: false, reason: 'verification_unavailable' });
    });

    it('classifies an unknown non-viem error as unavailable', async () => {
      // A plain Error carries no verdict, so it cannot mean "the wallet said no".
      await expect(failingWith(new Error('something broke'))).resolves.toEqual({
        ok: false,
        reason: 'verification_unavailable',
      });
    });

    it('never produces a successful result from an infrastructure failure', async () => {
      for (const err of [
        new HttpRequestError({ url: 'https://rpc.example.com', status: 500 }),
        new TimeoutError({ body: {}, url: 'https://rpc.example.com' }),
        new Error('socket hang up'),
        'not even an error',
      ]) {
        const result = await failingWith(err);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.reason).toBe('verification_unavailable');
      }
    });
  });

  describe('classifyContractReadError', () => {
    it.each([
      ['a wrapped revert', revertError(), 'invalid_contract_signature'],
      [
        'zero returned data',
        new ContractFunctionZeroDataError({ functionName: 'isValidSignature' }),
        'invalid_contract_signature',
      ],
      [
        'an HTTP failure',
        new HttpRequestError({ url: 'https://rpc.example.com', status: 503 }),
        'verification_unavailable',
      ],
      [
        'a timeout',
        new TimeoutError({ body: {}, url: 'https://rpc.example.com' }),
        'verification_unavailable',
      ],
      ['a plain Error', new Error('x'), 'verification_unavailable'],
      ['a thrown string', 'boom', 'verification_unavailable'],
      ['undefined', undefined, 'verification_unavailable'],
    ])('classifies %s', (_label, err, expected) => {
      expect(classifyContractReadError(err)).toBe(expected);
    });
  });

  describe('the expected reviewer is the subject of the check', () => {
    it('asks isValidSignature on the expected address', async () => {
      const { reader, asked } = fakeReader();

      await verifyAgainstWallet(reader);

      const call = asked.find((a) => a['call'] === 'isValidSignature');
      expect(call?.['address']).toBe(WALLET);
      expect(asked.find((a) => a['call'] === 'getCode')?.['address']).toBe(WALLET);
    });

    it('does not accept a signature a different wallet would vouch for', async () => {
      // The reader would say yes for anything, but the EOA signature recovers to
      // someone else and the expected address has no code — so there is nothing
      // vouching for the expected reviewer.
      const { reader } = fakeReader({ code: '0x' });
      const signature = await signWith(OTHER_KEY, BASE);

      await expect(
        verifyWalletSignature({
          expectedReviewer: reviewerAccount.address,
          typedData: BASE,
          signature,
          reader,
        }),
      ).resolves.toEqual({ ok: false, reason: 'signer_mismatch' });
    });

    it('asks about the digest of the typed data it was given', async () => {
      const { reader, asked } = fakeReader();
      const data = typedDataFor(WALLET);

      await verifyWalletSignature({
        expectedReviewer: WALLET,
        typedData: data,
        signature: CONTRACT_SIGNATURE,
        reader,
      });

      // The wallet must be asked about this exact document, not some other.
      const expectedHash = hashTypedData({
        domain: data.domain,
        types: data.types,
        primaryType: data.primaryType,
        message: data.message,
      });

      expect(asked.find((a) => a['call'] === 'isValidSignature')?.['hash']).toBe(expectedHash);
    });

    it('asks about a different digest when the content differs', async () => {
      const ask = async (overrides: Record<string, unknown>) => {
        const { reader, asked } = fakeReader();
        await verifyWalletSignature({
          expectedReviewer: WALLET,
          typedData: typedDataFor(WALLET, overrides),
          signature: CONTRACT_SIGNATURE,
          reader,
        });
        return asked.find((a) => a['call'] === 'isValidSignature')?.['hash'];
      };

      expect(await ask({})).not.toBe(await ask({ value: 81n }));
    });
  });

  describe('RPC failures are not rejections', () => {
    it('reports a failed head lookup as unavailable', async () => {
      const { reader } = fakeReader({
        head: () => {
          throw new Error('fetch failed: https://rpc.example.com/v1/secret-key');
        },
      });

      const result = await verifyAgainstWallet(reader);

      expect(result).toEqual({ ok: false, reason: 'verification_unavailable' });
      expect(JSON.stringify(result)).not.toContain('secret-key');
    });

    it('reports a failed bytecode lookup as unavailable', async () => {
      const { reader } = fakeReader({
        code: () => {
          throw new Error('fetch failed');
        },
      });

      await expect(verifyAgainstWallet(reader)).resolves.toEqual({
        ok: false,
        reason: 'verification_unavailable',
      });
    });

    it('never turns an outage into a pass', async () => {
      for (const reader of [
        fakeReader({
          head: () => {
            throw new Error('down');
          },
        }).reader,
        fakeReader({
          code: () => {
            throw new Error('down');
          },
        }).reader,
        fakeReader({
          magic: () => {
            throw new Error('down');
          },
        }).reader,
      ]) {
        expect((await verifyAgainstWallet(reader)).ok).toBe(false);
      }
    });
  });

  describe('verification block', () => {
    it('pins both reads to one block hash, not merely a height', async () => {
      // A height alone would let the two calls land on different blocks at that
      // height if a reorg happened between them; a hash cannot.
      const { reader, asked } = fakeReader();

      await verifyAgainstWallet(reader);

      const pinned = asked.filter((a) => a['blockHash'] === HEAD.hash);
      expect(pinned).toHaveLength(2);
      expect(pinned.map((a) => a['call']).sort()).toEqual(['getCode', 'isValidSignature']);
      expect(asked.some((a) => 'blockNumber' in a && a['call'] !== 'getBlock')).toBe(false);
    });

    it('resolves the block exactly once', async () => {
      const { reader, asked } = fakeReader();

      await verifyAgainstWallet(reader);

      expect(asked.filter((a) => a['call'] === 'getBlock')).toHaveLength(1);
    });

    it('passes an explicit height through to block resolution', async () => {
      const { reader, asked } = fakeReader();

      const result = await verifyAgainstWallet(reader, { blockNumber: 19_000_000n });

      expect(asked.find((a) => a['call'] === 'getBlock')?.['blockNumber']).toBe(19_000_000n);
      expect(result).toEqual({
        ok: true,
        method: 'erc1271',
        block: { number: 19_000_000n, hash: HEAD.hash },
      });
    });

    it('reports the exact block the result is scoped to', async () => {
      // A wallet can rotate signers, so the result holds only for this block.
      const { reader } = fakeReader();

      const result = await verifyAgainstWallet(reader);

      expect(result.ok && result.method === 'erc1271' && result.block).toEqual(HEAD);
    });
  });
});

describe('the authorization must name the expected reviewer', () => {
  const WALLET: Address = getAddress(`0x${'77'.repeat(20)}`);
  const SOMEONE_ELSE: Address = getAddress(`0x${'99'.repeat(20)}`);

  it('rejects a valid signature over an authorization naming someone else', async () => {
    // The expected wallet really did sign this document — but the document
    // authorizes a review by a different reviewer, so it is not their consent.
    const forSomeoneElse = typedDataFor(SOMEONE_ELSE);
    const signature = await signWith(REVIEWER_KEY, forSomeoneElse);

    await expect(
      verifyWalletSignature({
        expectedReviewer: reviewerAccount.address,
        typedData: forSomeoneElse,
        signature,
      }),
    ).resolves.toEqual({ ok: false, reason: 'signer_mismatch' });
  });

  it('does not even attempt recovery when the reviewer differs', async () => {
    // A malformed signature would normally report malformed_signature; the
    // mismatch is caught first, so recovery never runs.
    await expect(
      verifyWalletSignature({
        expectedReviewer: reviewerAccount.address,
        typedData: typedDataFor(SOMEONE_ELSE),
        signature: '0xdeadbeef',
      }),
    ).resolves.toEqual({ ok: false, reason: 'signer_mismatch' });
  });

  it('rejects a contract-wallet case without touching the chain', async () => {
    const { reader, asked } = fakeReader();

    const result = await verifyWalletSignature({
      expectedReviewer: WALLET,
      typedData: typedDataFor(SOMEONE_ELSE),
      signature: `0x${'ab'.repeat(96)}`,
      reader,
    });

    expect(result).toEqual({ ok: false, reason: 'signer_mismatch' });
    expect(asked).toEqual([]);
  });

  it('is refused even before the ERC-6492 check', async () => {
    const { reader, asked } = fakeReader();

    const result = await verifyWalletSignature({
      expectedReviewer: WALLET,
      typedData: typedDataFor(SOMEONE_ELSE),
      signature: `0x${'ab'.repeat(96)}${ERC6492_SUFFIX.slice(2)}` as Hex,
      reader,
    });

    expect(result).toEqual({ ok: false, reason: 'signer_mismatch' });
    expect(asked).toEqual([]);
  });

  it('accepts when the two differ only in checksum casing', async () => {
    // Both sides are normalized, so casing must not cause a false mismatch.
    const data = typedDataFor(reviewerAccount.address);
    const signature = await signWith(REVIEWER_KEY, data);

    await expect(
      verifyWalletSignature({
        expectedReviewer: reviewerAccount.address.toLowerCase() as Address,
        typedData: data,
        signature,
      }),
    ).resolves.toEqual({ ok: true, method: 'eoa' });
  });

  it('matches a lowercase reviewer in the typed data', async () => {
    const data = typedDataFor(reviewerAccount.address.toLowerCase() as Address);
    const signature = await signWith(REVIEWER_KEY, data);

    await expect(
      verifyWalletSignature({
        expectedReviewer: reviewerAccount.address,
        typedData: data,
        signature,
      }),
    ).resolves.toEqual({ ok: true, method: 'eoa' });
  });
});

describe('incomplete block identity', () => {
  const WALLET: Address = getAddress(`0x${'77'.repeat(20)}`);

  /** A reader whose getBlock returns a block missing part of its identity. */
  function readerWithBlock(block: unknown): ContractWalletReader {
    return {
      async getBlock() {
        return block as VerificationBlock;
      },
      async getCode() {
        return WALLET_CODE;
      },
      async isValidSignature() {
        return ERC1271_MAGIC_VALUE as Hex;
      },
    };
  }

  it('reports a pending block from the real adapter as unavailable', async () => {
    // A pending block has a null number and hash; viem's adapter must refuse to
    // invent values for them.
    const client = createPublicClient({
      transport: custom({
        async request({ method }: { method: string }) {
          if (method === 'eth_getBlockByNumber') return { number: null, hash: null };
          return null;
        },
      }),
    });

    await expect(createPublicClientReader(client as never).getBlock()).rejects.toThrow(
      IncompleteBlockError,
    );
  });

  it.each([
    ['a missing hash', { number: 21_000_000n }],
    ['a missing number', { hash: `0x${'11'.repeat(32)}` }],
    ['both missing', {}],
  ])('treats %s as verification unavailable', async (_label, block) => {
    // The verifier must not pin reads to a block it cannot identify.
    const client = createPublicClient({
      transport: custom({
        async request({ method }: { method: string }) {
          if (method === 'eth_getBlockByNumber') {
            return {
              number: 'number' in block ? '0x1406f40' : null,
              hash: 'hash' in block ? `0x${'11'.repeat(32)}` : null,
            };
          }
          return null;
        },
      }),
    });

    await expect(createPublicClientReader(client as never).getBlock()).rejects.toThrow(
      IncompleteBlockError,
    );
  });

  it('reports a reader that cannot identify a block as unavailable', async () => {
    // A reader that throws — as the real adapter does for a pending block —
    // must never yield a verdict about the signature.
    const reader: ContractWalletReader = {
      ...readerWithBlock({}),
      async getBlock() {
        throw new IncompleteBlockError();
      },
    };

    await expect(
      verifyWalletSignature({
        expectedReviewer: WALLET,
        typedData: typedDataFor(WALLET),
        signature: `0x${'ab'.repeat(96)}`,
        reader,
      }),
    ).resolves.toEqual({ ok: false, reason: 'verification_unavailable' });
  });
});

describe('the real viem adapter', () => {
  const WALLET: Address = getAddress(`0x${'77'.repeat(20)}`);
  const BLOCK_HASH = `0x${'11'.repeat(32)}` as Hex;

  /** A client over a transport that records every JSON-RPC call. */
  function recordingClient(): {
    client: ReturnType<typeof createPublicClient>;
    seen: { method: string; params: readonly unknown[] }[];
  } {
    const seen: { method: string; params: readonly unknown[] }[] = [];
    const client = createPublicClient({
      transport: custom({
        async request({ method, params }: { method: string; params?: readonly unknown[] }) {
          seen.push({ method, params: params ?? [] });
          if (method === 'eth_getCode') return WALLET_CODE;
          if (method === 'eth_call') return `${ERC1271_MAGIC_VALUE}${'00'.repeat(28)}`;
          if (method === 'eth_getBlockByNumber') {
            return { number: '0x1406f40', hash: BLOCK_HASH };
          }
          return null;
        },
      }),
    });
    return { client, seen };
  }

  it('resolves a block with both a number and a hash', async () => {
    const { client } = recordingClient();

    await expect(createPublicClientReader(client as never).getBlock()).resolves.toEqual({
      number: 21_000_000n,
      hash: BLOCK_HASH,
    });
  });

  it('sends getCode hash-pinned and canonical-only', async () => {
    const { client, seen } = recordingClient();

    await createPublicClientReader(client as never).getCode({
      address: WALLET,
      blockHash: BLOCK_HASH,
    });

    const call = seen.find((s) => s.method === 'eth_getCode');
    // EIP-1898 block parameter, not a height or a tag.
    expect(call?.params[1]).toEqual({ blockHash: BLOCK_HASH, requireCanonical: true });
  });

  it('sends isValidSignature hash-pinned and canonical-only', async () => {
    const { client, seen } = recordingClient();

    await createPublicClientReader(client as never).isValidSignature({
      address: WALLET,
      hash: `0x${'aa'.repeat(32)}`,
      signature: `0x${'bb'.repeat(65)}`,
      blockHash: BLOCK_HASH,
    });

    const call = seen.find((s) => s.method === 'eth_call');
    expect(call?.params[1]).toEqual({ blockHash: BLOCK_HASH, requireCanonical: true });
    expect((call?.params[0] as { to: string }).to.toLowerCase()).toBe(WALLET.toLowerCase());
  });

  it('pins both reads to the same block hash', async () => {
    const { client, seen } = recordingClient();
    const reader = createPublicClientReader(client as never);

    const block = await reader.getBlock();
    await reader.getCode({ address: WALLET, blockHash: block.hash });
    await reader.isValidSignature({
      address: WALLET,
      hash: `0x${'aa'.repeat(32)}`,
      signature: `0x${'bb'.repeat(65)}`,
      blockHash: block.hash,
    });

    const pinned = seen
      .filter((s) => s.method === 'eth_getCode' || s.method === 'eth_call')
      .map((s) => s.params[1]);

    expect(pinned).toHaveLength(2);
    expect(pinned[0]).toEqual(pinned[1]);
    expect(pinned[0]).toEqual({ blockHash: block.hash, requireCanonical: true });
  });

  it('never sends a block tag or bare height for the pinned reads', async () => {
    const { client, seen } = recordingClient();
    const reader = createPublicClientReader(client as never);

    await reader.getCode({ address: WALLET, blockHash: BLOCK_HASH });

    const call = seen.find((s) => s.method === 'eth_getCode');
    expect(typeof call?.params[1]).toBe('object');
    expect(call?.params[1]).not.toBe('latest');
  });
});

describe('ERC-6492 is refused', () => {
  const WALLET: Address = getAddress(`0x${'77'.repeat(20)}`);

  it('rejects a signature carrying the ERC-6492 suffix', async () => {
    const wrapped = `0x${'ab'.repeat(96)}${ERC6492_SUFFIX.slice(2)}` as Hex;
    const { reader, asked } = fakeReader();

    const result = await verifyWalletSignature({
      expectedReviewer: WALLET,
      typedData: typedDataFor(WALLET),
      signature: wrapped,
      reader,
    });

    expect(result).toEqual({ ok: false, reason: 'erc6492_unsupported' });
    // Refused outright: the chain is never consulted.
    expect(asked).toEqual([]);
  });

  it('refuses it even when the wallet would accept it', async () => {
    const wrapped = `0x${'cd'.repeat(96)}${ERC6492_SUFFIX.slice(2)}` as Hex;
    const { reader } = fakeReader({ magic: ERC1271_MAGIC_VALUE });

    await expect(
      verifyWalletSignature({
        expectedReviewer: WALLET,
        typedData: typedDataFor(WALLET),
        signature: wrapped,
        reader,
      }),
    ).resolves.toEqual({ ok: false, reason: 'erc6492_unsupported' });
  });

  it('is case-insensitive about the suffix', async () => {
    const wrapped = `0x${'ab'.repeat(96)}${ERC6492_SUFFIX.slice(2).toUpperCase()}` as Hex;

    await expect(
      verifyWalletSignature({
        expectedReviewer: WALLET,
        typedData: typedDataFor(WALLET),
        signature: wrapped,
      }),
    ).resolves.toEqual({ ok: false, reason: 'erc6492_unsupported' });
  });

  it('does not reject an ordinary signature that merely contains the bytes', async () => {
    // Only a trailing suffix marks ERC-6492; the same bytes elsewhere do not.
    const notWrapped = `0x${ERC6492_SUFFIX.slice(2)}${'ab'.repeat(96)}` as Hex;

    const result = await verifyWalletSignature({
      expectedReviewer: reviewerAccount.address,
      typedData: BASE,
      signature: notWrapped,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).not.toBe('erc6492_unsupported');
  });
});

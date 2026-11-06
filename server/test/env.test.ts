import { describe, expect, it } from 'vitest';
import { EnvValidationError, SECRET_ENV_KEYS, loadEnv, redactEnv } from '../src/config/env.js';
import { VALID_ENV, envWith } from './fixtures.js';

/** The issue keys reported by loading `source`, or [] if it succeeds. */
function issueKeys(source: Record<string, string | undefined>): string[] {
  try {
    loadEnv(source);
    return [];
  } catch (err) {
    if (err instanceof EnvValidationError) return err.issues.map((i) => i.key);
    throw err;
  }
}

describe('loadEnv', () => {
  it('accepts a complete configuration', () => {
    const env = loadEnv(VALID_ENV);

    expect(env.port).toBe(3000);
    expect(env.nodeEnv).toBe('test');
    expect(env.chainId).toBe(11155111);
    expect(env.databasePath).toBe(':memory:');
  });

  it('checksums the gateway address', () => {
    const lowercase = `0x${'ab'.repeat(20)}`;
    const env = loadEnv(envWith({ REVIEW_GATEWAY_ADDRESS: lowercase }));

    // Same address, but returned in EIP-55 mixed-case form rather than as given.
    expect(env.reviewGatewayAddress.toLowerCase()).toBe(lowercase);
    expect(env.reviewGatewayAddress).not.toBe(lowercase);
    expect(env.reviewGatewayAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('accepts an already-checksummed address', () => {
    const checksummed = loadEnv(
      envWith({ REVIEW_GATEWAY_ADDRESS: `0x${'ab'.repeat(20)}` }),
    ).reviewGatewayAddress;

    expect(loadEnv(envWith({ REVIEW_GATEWAY_ADDRESS: checksummed })).reviewGatewayAddress).toBe(
      checksummed,
    );
  });

  describe('required variables', () => {
    const required = [
      'WORLD_APP_ID',
      'WORLD_RP_ID',
      'WORLD_SIGNING_KEY',
      'RECORD_SERVER_PRIVATE_KEY',
      'REVIEW_GATEWAY_ADDRESS',
      'CHAIN_ID',
      'RPC_URL',
      'REVIEW_CONTENT_BASE_URL',
    ];

    for (const key of required) {
      it(`rejects a missing ${key}`, () => {
        expect(issueKeys(envWith({ [key]: undefined }))).toEqual([key]);
      });

      it(`treats a blank ${key} as missing`, () => {
        expect(issueKeys(envWith({ [key]: '   ' }))).toEqual([key]);
      });
    }

    it('reports every missing variable in one pass', () => {
      const keys = issueKeys({});
      expect(keys).toEqual(required);
    });
  });

  describe('optional variables', () => {
    it('defaults PORT, NODE_ENV and DATABASE_PATH', () => {
      const env = loadEnv(
        envWith({ PORT: undefined, NODE_ENV: undefined, DATABASE_PATH: undefined }),
      );

      expect(env.port).toBe(3000);
      expect(env.nodeEnv).toBe('development');
      expect(env.databasePath).toBe('./data/receipts.db');
    });
  });

  describe('CHAIN_ID', () => {
    it.each(['0', '-1', 'abc', '1.5', '1e3', ''])('rejects %o', (value) => {
      expect(issueKeys(envWith({ CHAIN_ID: value }))).toEqual(['CHAIN_ID']);
    });

    it('accepts mainnet', () => {
      expect(loadEnv(envWith({ CHAIN_ID: '1' })).chainId).toBe(1);
    });
  });

  describe('REVIEW_GATEWAY_ADDRESS', () => {
    it.each([
      '0x123',
      'not-an-address',
      `${'22'.repeat(20)}`, // missing 0x
      `0x${'22'.repeat(21)}`, // too long
    ])('rejects %o', (value) => {
      expect(issueKeys(envWith({ REVIEW_GATEWAY_ADDRESS: value }))).toEqual([
        'REVIEW_GATEWAY_ADDRESS',
      ]);
    });

    it('rejects the zero address', () => {
      expect(issueKeys(envWith({ REVIEW_GATEWAY_ADDRESS: `0x${'00'.repeat(20)}` }))).toEqual([
        'REVIEW_GATEWAY_ADDRESS',
      ]);
    });
  });

  describe('PORT', () => {
    it.each(['0', '65536', '-1', 'eighty', '80.5'])('rejects %o', (value) => {
      expect(issueKeys(envWith({ PORT: value }))).toEqual(['PORT']);
    });

    it('accepts the upper bound', () => {
      expect(loadEnv(envWith({ PORT: '65535' })).port).toBe(65535);
    });
  });

  describe('NODE_ENV', () => {
    it('rejects an unknown value', () => {
      expect(issueKeys(envWith({ NODE_ENV: 'staging' }))).toEqual(['NODE_ENV']);
    });
  });

  describe('WORLD_APP_ID', () => {
    it('rejects an rp_ identifier in the app slot', () => {
      expect(issueKeys(envWith({ WORLD_APP_ID: 'rp_staging_abc123' }))).toEqual(['WORLD_APP_ID']);
    });

    it.each(['app_', 'appid', 'staging_abc', 'app-abc', 'APP_abc'])('rejects %o', (value) => {
      expect(issueKeys(envWith({ WORLD_APP_ID: value }))).toEqual(['WORLD_APP_ID']);
    });

    it.each(['app_abc123', 'app_staging_4f1a2b', 'app_with-hyphen'])('accepts %o', (value) => {
      expect(loadEnv(envWith({ WORLD_APP_ID: value })).worldAppId).toBe(value);
    });
  });

  describe('WORLD_RP_ID', () => {
    it('rejects an app_ identifier in the rp slot', () => {
      expect(issueKeys(envWith({ WORLD_RP_ID: 'app_staging_abc123' }))).toEqual(['WORLD_RP_ID']);
    });

    it.each(['rp_', 'rpid', 'staging_abc', 'RP_abc'])('rejects %o', (value) => {
      expect(issueKeys(envWith({ WORLD_RP_ID: value }))).toEqual(['WORLD_RP_ID']);
    });

    it.each(['rp_abc123', 'rp_staging_4f1a2b'])('accepts %o', (value) => {
      expect(loadEnv(envWith({ WORLD_RP_ID: value })).worldRpId).toBe(value);
    });

    it('is independent of WORLD_APP_ID', () => {
      const env = loadEnv(
        envWith({ WORLD_APP_ID: 'app_staging_aaa', WORLD_RP_ID: 'rp_staging_bbb' }),
      );

      expect(env.worldAppId).toBe('app_staging_aaa');
      expect(env.worldRpId).toBe('rp_staging_bbb');
    });
  });

  describe('WORLD_SIGNING_KEY', () => {
    it.each([
      'test-signing-key-not-a-real-credential',
      '0x1234',
      `0x${'33'.repeat(31)}`,
      `0x${'zz'.repeat(32)}`,
      '33'.repeat(31),
    ])('rejects %o', (value) => {
      expect(issueKeys(envWith({ WORLD_SIGNING_KEY: value }))).toEqual(['WORLD_SIGNING_KEY']);
    });

    it('accepts a 32-byte hex key without the 0x prefix', () => {
      expect(loadEnv(envWith({ WORLD_SIGNING_KEY: '33'.repeat(32) })).worldSigningKey).toBe(
        `0x${'33'.repeat(32)}`,
      );
    });

    it('normalizes to 0x-prefixed lowercase', () => {
      expect(loadEnv(envWith({ WORLD_SIGNING_KEY: `0x${'AB'.repeat(32)}` })).worldSigningKey).toBe(
        `0x${'ab'.repeat(32)}`,
      );
    });
  });

  describe('RECORD_SERVER_PRIVATE_KEY', () => {
    it.each([
      '0x123',
      '11'.repeat(32), // missing 0x
      `0x${'11'.repeat(31)}`, // too short
      `0x${'zz'.repeat(32)}`, // not hex
    ])('rejects %o', (value) => {
      expect(issueKeys(envWith({ RECORD_SERVER_PRIVATE_KEY: value }))).toEqual([
        'RECORD_SERVER_PRIVATE_KEY',
      ]);
    });

    it('normalizes to lowercase', () => {
      const env = loadEnv(envWith({ RECORD_SERVER_PRIVATE_KEY: `0x${'AB'.repeat(32)}` }));
      expect(env.recordServerPrivateKey).toBe(`0x${'ab'.repeat(32)}`);
    });
  });

  describe('secret handling', () => {
    it('never puts a secret value in the error message', () => {
      const secretValue = 'super-secret-value-that-must-never-be-logged-0123456789';

      let message = '';
      try {
        loadEnv({
          ...envWith({ CHAIN_ID: 'bogus' }),
          WORLD_SIGNING_KEY: secretValue,
          RECORD_SERVER_PRIVATE_KEY: secretValue,
        });
      } catch (err) {
        message = (err as Error).message;
      }

      expect(message).not.toBe('');
      expect(message).not.toContain(secretValue);
    });

    it('never puts a rejected secret value in its own issue', () => {
      const badSecret = 'short';

      let message = '';
      try {
        loadEnv(envWith({ WORLD_SIGNING_KEY: badSecret }));
      } catch (err) {
        message = (err as Error).message;
      }

      expect(message).toContain('WORLD_SIGNING_KEY');
      expect(message).not.toContain(badSecret);
    });
  });
});

describe('redactEnv', () => {
  it('replaces every secret and keeps the rest', () => {
    const env = loadEnv(VALID_ENV);
    const redacted = redactEnv(env);

    const fieldFor: Record<(typeof SECRET_ENV_KEYS)[number], string> = {
      WORLD_SIGNING_KEY: 'worldSigningKey',
      RECORD_SERVER_PRIVATE_KEY: 'recordServerPrivateKey',
      RPC_URL: 'rpcUrl',
      DATABASE_URL: 'databaseUrl',
    };

    for (const key of SECRET_ENV_KEYS) {
      // DATABASE_URL is only set when the postgres driver is selected; the
      // default fixture is sqlite, so it is absent rather than redacted.
      const value = (VALID_ENV as Record<string, string | undefined>)[key];
      if (value === undefined) continue;
      expect(redacted[fieldFor[key]]).toBe('[redacted]');
      expect(JSON.stringify(redacted)).not.toContain(value);
    }

    expect(redacted.chainId).toBe(11155111);
    expect(redacted.port).toBe(3000);
  });
});

describe('RPC_URL', () => {
  it.each([
    'not-a-url',
    'ftp://rpc.example.com',
    'ws://rpc.example.com',
    '//rpc.example.com',
    '/path',
  ])('rejects %o', (value) => {
    expect(() => loadEnv(envWith({ RPC_URL: value }))).toThrow(EnvValidationError);
  });

  it.each(['http://localhost:8545', 'https://rpc.example.com/v1/key'])('accepts %o', (value) => {
    expect(loadEnv(envWith({ RPC_URL: value })).rpcUrl).toBe(value);
  });

  it('never echoes the URL in a rejection, since it can carry an API key', () => {
    const withKey = 'ftp://rpc.example.com/v1/super-secret-api-key-0123456789';

    let message = '';
    try {
      loadEnv(envWith({ RPC_URL: withKey }));
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('RPC_URL');
    expect(message).not.toContain('super-secret-api-key-0123456789');
    expect(message).not.toContain(withKey);
  });
});
